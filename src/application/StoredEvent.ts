export interface StoredEvent {
    aggregateId: string,
    aggregateVersion: number,
    name: string,
    payload: string,
    occurredAt: Date
};