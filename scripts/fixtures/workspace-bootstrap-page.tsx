/** @jsxImportSource preact */
import { render } from 'preact';
import { startReplica, call, replicaStatus } from '../../src/webui/data/replica.ts';
import { UpgradePrompt, UpgradeWarning } from '../../src/webui/settings/upgrade-prompt.tsx';
import { UiHost } from '../../src/webui/ui.tsx';
localStorage.setItem('mh_origin_mode','none');
startReplica();
Object.assign(window, { acceptance: { call, replicaStatus, connect: () => call('addStorageReplica', { endpoint:location.origin,region:'test',bucket:'synthetic',prefix:'fixture',accessKeyId:'test',secretAccessKey:'test',encrypt:false,publish:false }, '') }});
render(<UpgradePrompt><UpgradeWarning/><UiHost/></UpgradePrompt>,document.getElementById('app')!);
