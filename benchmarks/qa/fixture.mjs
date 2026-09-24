import http from 'node:http';

export const claims = [
  [
    'invite/admin',
    'An admin can invite a new valid email; success adds exactly one pending invitation.',
  ],
  [
    'invite/viewer',
    'A viewer cannot invite a member; rejection leaves pending invitations unchanged.',
  ],
  [
    'invite/duplicate',
    'Inviting an already pending email, including different letter case, is rejected without adding a second invitation.',
  ],
  [
    'invite/capacity',
    'An admin cannot invite when occupied seats equal the seat limit; rejection leaves invitations unchanged.',
  ],
  ['accept/valid', 'Accepting a valid invitation succeeds and adds exactly one member.'],
  ['accept/expired', 'Accepting an expired invitation is rejected without adding a member.'],
  [
    'accept/reused',
    'Accepting an invitation twice is rejected the second time and adds no additional member.',
  ],
  ['invite/invalid', 'An invalid email is rejected without adding an invitation.'],
];
export const defects = new Set([
  'invite/viewer',
  'invite/duplicate',
  'invite/capacity',
  'accept/expired',
]);

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Team workspace</title>
<style>body{font:18px system-ui;max-width:800px;margin:48px auto;color:#18332d}section{padding:20px;border:1px solid #bbb;margin:20px 0}label,button{margin:10px;display:inline-block}input,select,button{font:inherit;padding:8px}#message{font-weight:bold}</style>
<h1>Team workspace</h1><p>Disposable QA workspace. Reset returns to initial data.</p>
<section><h2>Workspace setup</h2><label>Role <select id="role"><option>admin</option><option>viewer</option></select></label>
<label>Occupied seats <input id="occupied" type="number" value="1"></label><label>Seat limit <input id="limit" type="number" value="3"></label>
<button id="configure">Apply setup</button><button id="reset">Reset workspace</button></section>
<section><h2>Invite member</h2><label>Email <input id="email"></label><button id="invite">Invite</button></section>
<section><h2>Accept invitation</h2><p>Seeded tokens: valid-token, expired-token. Each can be tested after a reset.</p>
<label>Invitation token <input id="token" value="valid-token"></label><button id="accept">Accept invitation</button></section>
<p id="message" role="status"></p><pre id="state"></pre>
<script>
const $=id=>document.getElementById(id);
async function act(action,data={}) {const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...data})});const d=await r.json();$('message').textContent=d.message;$('state').textContent=JSON.stringify(d.state,null,2);$('role').value=d.state.role;$('occupied').value=d.state.occupied;$('limit').value=d.state.limit;}
$('reset').onclick=()=>act('reset');$('configure').onclick=()=>act('configure',{role:$('role').value,occupied:Number($('occupied').value),limit:Number($('limit').value)});
$('invite').onclick=()=>act('invite',{email:$('email').value});$('accept').onclick=()=>act('accept',{token:$('token').value});act('state');
</script></html>`;

export async function startFixture(buggy = false) {
  let state;
  let used;
  const reset = () => {
    state = { role: 'admin', occupied: 1, limit: 3, invitations: [], members: [] };
    used = new Set();
  };
  reset();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/action') {
      res.writeHead(404);
      res.end();
      return;
    }
    let input;
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      input = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let message = 'Workspace ready';
    const { action, email, token } = input;
    if (action === 'reset') reset();
    if (action === 'configure') {
      state.role = input.role;
      state.occupied = input.occupied;
      state.limit = input.limit;
      message = 'Setup applied';
    }
    if (action === 'invite') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '')) message = 'Invalid email';
      else if (!buggy && state.role !== 'admin') message = 'Permission denied';
      else if (!buggy && state.occupied >= state.limit) message = 'Seat limit reached';
      else if (
        state.invitations.some((e) =>
          buggy ? e === email : e.toLowerCase() === email.toLowerCase(),
        )
      )
        message = 'Already invited';
      else {
        state.invitations.push(email);
        message = 'Invitation created';
      }
    }
    if (action === 'accept') {
      if (!['valid-token', 'expired-token'].includes(token)) message = 'Unknown invitation';
      else if (used.has(token)) message = 'Invitation already used';
      else if (!buggy && token === 'expired-token') message = 'Invitation expired';
      else {
        used.add(token);
        state.members.push(token === 'valid-token' ? 'member@example.com' : 'late@example.com');
        message = 'Membership activated';
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message, state }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function contract(url) {
  return {
    version: '2',
    name: 'Team workspace QA',
    description:
      'Reviewed acceptance behaviors for a disposable team workspace. Use Reset workspace before each independent check. Workspace setup controls role and seat counts; seeded valid-token and expired-token test invitation acceptance.',
    target: { type: 'web', url },
    areas: ['invite', 'accept'].map((id) => ({
      id,
      name: id === 'invite' ? 'Invitations' : 'Membership activation',
      behaviors: claims
        .filter(([key]) => key.startsWith(id + '/'))
        .map(([key, description]) => ({ id: key.split('/')[1], description })),
    })),
  };
}
