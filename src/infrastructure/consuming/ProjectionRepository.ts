import { EntityManager, FindOneOptions, FindManyOptions, DeleteResult, DataSource, BaseEntity } from "typeorm";
import { QueryDeepPartialEntity } from "typeorm/query-builder/QueryPartialEntity";
import { NoInboxEventFoundError } from "./errors/NoInboxEventFoundError";
import { IProjectionInboxEntity, ProjectionInboxEntity } from "./ProjectionInboxEntity";
import { IProjectionPositionEntity, ProjectionPositionEntity } from "./ProjectionPositionEntity";
import { InboundEvent } from "../../application/InboundEvent";
import { InboundEventFactory } from "./InboundEventFactory";

export interface IProjectionRepositoryMethods {
    getOne: (findOneOptions: FindOneOptions) => Promise<any | null>;
    getMany: (findManyOptions: FindManyOptions) => Promise<any[]>;
    updateOne: (projectedEntity: any) => Promise<any | null>;
    updateMany: (projectedEntities: any[]) => Promise<any[]>;
    delete: (findManyOptions: FindManyOptions) => Promise<number | null | undefined>;
}

/**
 * Persists incoming events from inbox and projects events from inbox.
 * 
 * Demos: 
 * 
 * - [Consuming](https://codebricks.tech/docs/code/techniques/consuming)
 * 
 */
export abstract class ProjectionRepository<TInboxEntity extends ProjectionInboxEntity, TPositionEntity extends ProjectionPositionEntity, TProjectedEntity extends BaseEntity, TProjectionRepositoryMethods extends IProjectionRepositoryMethods> {

    /**
     * Initializes ProjectionRepository
     * 
     * @param datasource - Typeorm DataSource
     * @param inboxEntity - Projection's inbox Typeorm entity
     * @param positionEntity - Projection's position Typeorm entity 
     * @param projectedEntity - Projection's Typeorm  entity
     * @param eventFactory - Event factory for deserialization
     */
    protected constructor(
        readonly datasource: DataSource,
        readonly inboxEntity: new (params: IProjectionInboxEntity) => TInboxEntity,
        readonly positionEntity: new (params: IProjectionPositionEntity) => TPositionEntity,
        readonly projectedEntity: new (params: any) => TProjectedEntity,
        readonly eventFactory: InboundEventFactory,
    ) {
    }

    /**
     * Inserts events into Projection's inbox.
     * 
     * @param events - Event to insert into Inbox
     * @returns  
     */
    async insertIntoInbox(events: IProjectionInboxEntity[]): Promise<void> {
        try {
            await this.datasource.manager.save(
                events.map((event: IProjectionInboxEntity) => new this.inboxEntity(event)),
                { chunk: 10 }
            );
        } catch (error: any) {
            if (error?.code == 23505) {
                return;
            }
            throw error;
        }
    }

    /**
     * Gets next inbox event according to the position and passes it to callback project method. 
     * Increases projection's position afterwards and deletes the projected inbox events.
     * 
     * @param projectionName - Projection's name
     * @param streamName - Consumed stream name
     * @param projectMethod - Callback project method
     * @returns Last projected event no
     */
    async projectNextInboxEvent(projectionName: string, streamName: string, projectMethod: (inboundEvent: InboundEvent<any>, methods: TProjectionRepositoryMethods) => Promise<void>): Promise<number | null> {
        try {
            const lastProjectedNo: number | null = await this.getProjectionPosition(this.datasource.manager, projectionName, streamName);
            if (lastProjectedNo == null) {
                console.log(`Error getting last projected event no for ${projectionName} and stream ${streamName}`);
                throw new Error(`Error getting last projected event no for ${projectionName} and stream ${streamName}`);
            }
            await this.datasource.manager.transaction("READ COMMITTED", async (transactionalEntityManager: EntityManager) => {
                const inboxEvent: TInboxEntity | null = await this.getFromInbox(transactionalEntityManager, projectionName, streamName, lastProjectedNo + 1);
                if (!inboxEvent) {
                    throw new NoInboxEventFoundError(`No inbox event found for no ${lastProjectedNo + 1} of ${projectionName} and stream ${streamName}`);
                }
                const inboundEvent: InboundEvent<any> | null = await this.parseRawInboxEvent(inboxEvent);
                if (inboundEvent) {
                    try {
                        await projectMethod(
                            inboundEvent,
                            {
                                getOne: (findOneOptions: FindOneOptions) => this.getOne(transactionalEntityManager, findOneOptions),
                                getMany: (findManyOptions: FindManyOptions) => this.getMany(transactionalEntityManager, findManyOptions),
                                updateOne: (projectedEntity: TProjectedEntity) => this.updateOne(transactionalEntityManager, projectedEntity),
                                updateMany: (projectedEntities: TProjectedEntity[]) => this.updateMany(transactionalEntityManager, projectedEntities),
                                delete: (findManyOptions: FindManyOptions) => this.delete(transactionalEntityManager, findManyOptions)
                            } as TProjectionRepositoryMethods
                        );
                    } catch (error: any) {
                        if (!(error instanceof TypeError)) {
                            throw error;
                        }
                    }
                }
                await this.updateProjectionPosition(transactionalEntityManager, projectionName, streamName, inboxEvent.no);
                await this.deleteInboxEntriesUntil(transactionalEntityManager, projectionName, streamName, lastProjectedNo);
            });
            return lastProjectedNo + 1;
        } catch (error: any) {
            if (error instanceof NoInboxEventFoundError) {
                return null;
            }
            console.log(error);
            return null;
        }
    }

    private async getFromInbox(entityManager: EntityManager, projectionName: string, streamName: string, no: number): Promise<TInboxEntity | null> {
        return await entityManager
            .getRepository(this.inboxEntity)
            .createQueryBuilder(this.inboxEntity.name)
            .setLock("pessimistic_write")
            .setOnLocked("skip_locked")
            .where('projection_name = :projectionName', { projectionName: projectionName })
            .andWhere('stream_name = :streamName', { streamName: streamName })
            .andWhere('no = :no', { no: no })
            .getOne();
    }

    private async getProjectionPosition(entityManager: EntityManager, projectionName: string, streamName: string): Promise<number | null> {
        try {
            const findOptions: FindOneOptions<ProjectionPositionEntity> = {
                where: {
                    projectionName: projectionName,
                    streamName: streamName
                }
            };
            const position: TPositionEntity | null = await entityManager.findOne(
                this.positionEntity,
                findOptions as FindOneOptions<TPositionEntity>
            );
            return position ? position.lastProjectedNo : 0;
        } catch (error: any) {
            console.log(error);
            return null;
        }
    }

    private async deleteInboxEntriesUntil(transactionalEntityManager: EntityManager, projectionName: string, streamName: string, lastProjectedNo: number) {
        await transactionalEntityManager
            .getRepository(this.inboxEntity)
            .createQueryBuilder(this.inboxEntity.name)
            .where('projection_name = :projectionName', { projectionName: projectionName })
            .andWhere('stream_name = :streamName', { streamName: streamName })
            .andWhere('no <= :no', { no: lastProjectedNo + 1 })
            .delete()
            .execute();
    }

    private async updateProjectionPosition(transactionalEntityManager: EntityManager, projectionName: string, streamName: string, no: number) {
        const updatePositionEntry: QueryDeepPartialEntity<ProjectionPositionEntity> = {
            projectionName: projectionName,
            streamName: streamName,
            lastProjectedNo: no,
            updatedAt: new Date(),
        };
        await transactionalEntityManager
            .getRepository(this.positionEntity)
            .upsert(
                updatePositionEntry as QueryDeepPartialEntity<TPositionEntity>,
                ['projectionName', 'streamName']
            );
    }

    private async parseRawInboxEvent(rawEvent: TInboxEntity): Promise<InboundEvent<any> | null> {
        const eventName: string = JSON.parse(rawEvent.message).name;
        try {
            return this.eventFactory.getInboundEvent[eventName](rawEvent);
        } catch (error: any) {
            if (!(error instanceof TypeError)) {
                throw error;
            }
        }

        return null;
    }

    async getOne(entityManager: EntityManager, findOneOptions: FindOneOptions): Promise<TProjectedEntity | null> {
        return await entityManager.findOne(this.projectedEntity, findOneOptions);
    }

    async getMany(entityManager: EntityManager, findManyOptions: FindManyOptions): Promise<TProjectedEntity[]> {
        return await entityManager.find(this.projectedEntity, findManyOptions);
    }

    async updateOne(entityManager: EntityManager, projectedEntity: any): Promise<TProjectedEntity | null> {
        return await entityManager.save(new this.projectedEntity(projectedEntity));
    }

    async updateMany(entityManager: EntityManager, projectedEntities: any[]): Promise<TProjectedEntity[]> {
        return await entityManager.save(projectedEntities.map((projectedEntity: any) => new this.projectedEntity(projectedEntity)));
    }

    async delete(entityManager: EntityManager, findManyOptions: FindManyOptions): Promise<number | null | undefined> {
        const deleteResult: DeleteResult = await entityManager.delete(this.projectedEntity, findManyOptions.where);
        return deleteResult.affected;
    }
}
