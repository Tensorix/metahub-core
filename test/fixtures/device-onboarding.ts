import { mkdtempSync, rmSync } from 'node:fs';
const root = new URL("../../", import.meta.url).pathname;
const dir = mkdtempSync('/tmp/mh-enroll-');
process.env.METAHUB_HOME = dir + '/server';
const { startServer } = await import(root + '/src/core/sync/server.ts');
const s = startServer({ port: 0, host: '127.0.0.1', token: 'integration-only', autoSync: false });
const url = `http://127.0.0.1:${s.port}`;
async function cli(args: string[], ok = true) {
 const p = Bun.spawn(['bun', root + '/src/cli/index.ts', ...args], { env: { ...process.env, METAHUB_HOME: dir + '/client' }, stdout:'pipe', stderr:'pipe' });
 const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
 if ((code === 0) !== ok) throw new Error(`${args[0]}: ${code} ${out} ${err}`);
 return out;
}
try {
 const r = await fetch(url + '/api/pair/new', {method:'POST',headers:{authorization:'Bearer integration-only'}});
 const { code } = await r.json() as any;
 await cli(['config','device','add','--url',url,'--code',code]);
 await cli(['sync']);
 const { openMetahub } = await import(root + '/src/core/db.ts');
 const { generatePairingCode } = await import(root + '/src/core/sync/pairing.ts');
 const expired = generatePairingCode(openMetahub(), -1000);
 await cli(['config','device','add','--url',url,'--code',expired.code], false);
 await cli(['config','device','add','--url',url,'--code',code], false);
 console.log('PASS: HTTP pairing, initial sync, subsequent CLI sync, used-code rejection');
} finally { s.stop(); rmSync(dir,{recursive:true,force:true}); }
