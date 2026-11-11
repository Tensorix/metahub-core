export const SYNCED_EVENT = 'mh-synced', REPLICA_LIFECYCLE_EVENT = 'mh-replica-lifecycle';
export const replicaActive = () => false;
export const replicaEnabled = () => false;
export const isNoOrigin = () => true;
export const onReplicaStatus = (_listener: unknown) => () => {};
export const call = async () => { throw new Error('请在原生详情中执行此操作'); };
export const clientMode = () => 'native';
export const replicaStatus = () => ({state:'ready',paired:true});
