import { AggregateRoot } from '../domain'
import { Uuid } from '@node-ts/ddd-types'
import { unmanaged, injectable } from 'inversify'
import { WriteModel } from './write-model'
import { Connection, Repository } from 'typeorm'
import { ClassConstructor, assertUnreachable } from '../util'
import { AggregateNotFound, DeletingNewAggregate } from './error'
import { Logger } from '@node-ts/logger-core'

enum DmlOperation {
  Insert,
  Update,
  Delete
}

@injectable()
export abstract class WriteRepository <
  AggregateRootType extends AggregateRoot,
  WriteModelType extends WriteModel
> {
  /**
   * A respository that concretely deals with @template WriteModelType. This should rarely
   * be used in sub-classes as most retrieval operations should use getById(), whilst all
   * save operations must use save()
   */
  protected readonly repository: Repository<WriteModelType>

  /**
   * A write repository deals with retrieval and persistence of aggregate roots only.
   * Retrieval of aggregate roots are generally done just by Id, and generally return
   * the entire aggregate.
   *
   * Entities outside of the aggregate boundary are not returned. If you need this
   * functionality, you probably need to use a @see ReadRepository
   *
   * @param aggregateRootConstructor The class definition of the aggregate root of this repository
   * @param databaseConnection An open connection to the underlying data store
   * @param writeModelConstructor The class definition of the write model
   */
  constructor (
    @unmanaged() private readonly aggregateRootConstructor: ClassConstructor<AggregateRootType>,
    @unmanaged() private readonly writeModelConstructor: ClassConstructor<WriteModelType>,
    @unmanaged() private readonly databaseConnection: Connection,
    @unmanaged() protected readonly logger: Logger
  ) {
    this.repository = databaseConnection.getRepository(writeModelConstructor)
  }

  /**
   * Retrieve an aggregate from the underlying persistence using its Id
   *
   * @throws {AggregateNotFound} if no aggregate root with @param id could be found
   */
  async getById (id: Uuid): Promise<AggregateRootType> {
    const writeModel = await this.repository.findOne(id)
    if (writeModel === undefined) {
      throw new AggregateNotFound(this.aggregateRootConstructor.name, id)
    }
    return this.toAggregateRoot(writeModel)
  }

  /**
   * Persist the entire aggregate, including any child entities. This operation
   * should be transactional so that all aggregate entities are saved or none.
   *
   * @throws {AggregateAlreadyExists} if the aggregate being persisted already exists in the data store
   */
  async save (aggregateRoot: AggregateRootType): Promise<void> {
    this.logger.debug('Saving aggregate root', { aggregateRoot })
    const writeModel = Object.assign(new this.writeModelConstructor(), aggregateRoot)

    return this.doSave(aggregateRoot, writeModel)
  }

  protected async doSave (
    aggregateRoot: AggregateRootType,
    writeModel: WriteModelType
  ): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      let caughtError: Error | undefined
      // TODO Relax the isolation level
      await this.databaseConnection.transaction(async entityManager => {
        try {
          const dmlOperation = this.determineDmlOperation(aggregateRoot)
          switch (dmlOperation) {
            case DmlOperation.Insert:
              this.logger.debug('Inserting aggregate write model to data store', { writeModel })
              await entityManager.save(writeModel)
              break
            case DmlOperation.Update:
              this.logger.debug('Updating aggregate write model in data store', { writeModel })
              // TODO agg root version locking
              await entityManager.save(writeModel)
              break
            case DmlOperation.Delete:
              // TODO agg root version locking
              this.logger.debug('Deleting aggregate write model from data store', { writeModel })
              await entityManager.delete(this.writeModelConstructor, writeModel.id)
              break
            default:
              assertUnreachable(dmlOperation)
          }
        } catch (err) {
          caughtError = err
        }
      })
      if (caughtError) {
        reject(caughtError)
      } else {
        resolve()
      }
    })
  }

  /**
   * Converts a model fetched from the data store into an aggregate instance
   * @param model Data model fetched from the database, includes any aggregate child entities
   */
  protected toAggregateRoot (model: WriteModelType): AggregateRootType {
    return Object.assign(
      new this.aggregateRootConstructor(model.id),
      model,
      { fetchVersion: model.version }
    )
  }

  private determineDmlOperation (aggregateRoot: AggregateRoot): DmlOperation {
    if (aggregateRoot.isDeleted && aggregateRoot.fetchVersion === 0) {
      throw new DeletingNewAggregate(this.aggregateRootConstructor.name, aggregateRoot.id)
    } else if (aggregateRoot.fetchVersion === 0) {
      return DmlOperation.Insert
    } else if (aggregateRoot.isDeleted) {
      return DmlOperation.Delete
    } else {
      return DmlOperation.Update
    }
  }
}
