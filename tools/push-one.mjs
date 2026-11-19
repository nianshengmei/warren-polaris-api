/* tools/push-one.mjs — 只推一个提交（HEAD），用 GitHub Git Data API。
 *
 * 场景：github.com:443 的 git 通道被代理掐断（CONNECT 502），但 api.github.com 可用。
 * 与 push-via-api.mjs（逐提交重放全链路）不同，这里只处理 HEAD：
 *   远端 ref == HEAD~1 时，上传 HEAD 变更的 blob → 以 parent 的 tree 为 base 建 tree
 *   → 建 commit（复刻 message/author/committer）→ 快进更新 ref。
 * 每步都拿本地 git 对象 SHA 比对，任何不一致立即中止，不会破坏远端。
 *
 * 用法：GITHUB_TOKEN=<PAT> node tools/push-one.mjs
 */
import { execFileSync } from 'node:child_process';

const REPO = 'nianshengmei/warren-polaris-api';
const BRANCH = 'main';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('missing GITHUB_TOKEN env'); process.exit(1); }

const API = `https://api.github.com/repos/${REPO}`;
const HDRS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'warren-polaris-api-push',
  'Content-Type': 'application/json',
};

const git = (args) => execFileSync('git', args, { encoding: 'buffer' });
const gitt = (args) => execFileSync('git', args, { encoding: 'utf8' });

async function api(method, path, body, label) {
  let lastErr;
  for (let i = 1; i <= 4; i++) {
    try {
      const res = await fetch(API + path, { method, headers: HDRS, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (res.ok) return json;
      if (res.status < 500) throw new Error(`${label}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
      lastErr = new Error(`${label}: HTTP ${res.status}`);
    } catch (e) {
      if (/HTTP 4\d\d/.test(String(e.message))) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 2000 * i));
  }
  throw lastErr;
}

function parseIdent(line) {
  const m = line.match(/^(author|committer) (.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!m) throw new Error('无法解析 ident: ' + line);
  const ts = Number(m[4]);
  const off = m[5];
  const sign = off[0] === '-' ? -1 : 1;
  const hh = off.slice(1, 3), mm = off.slice(3, 5);
  const d = new Date(ts * 1000 + sign * (Number(hh) * 60 + Number(mm)) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    name: m[2], email: m[3],
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${sign > 0 ? '+' : '-'}${hh}:${mm}`,
  };
}

const headSha = gitt(['rev-parse', 'HEAD']).trim();
const parentSha = gitt(['rev-parse', 'HEAD~1']).trim();
const raw = gitt(['cat-file', 'commit', headSha]);
const headerBlock = raw.slice(0, raw.indexOf('\n\n'));
const message = raw.slice(raw.indexOf('\n\n') + 2);
const treeSha = headerBlock.match(/^tree ([0-9a-f]{40})$/m)[1];
const author = parseIdent(headerBlock.split('\n').find((l) => l.startsWith('author ')));
const committer = parseIdent(headerBlock.split('\n').find((l) => l.startsWith('committer ')));

const ref = await api('GET', `/git/ref/heads/${BRANCH}`, undefined, 'get ref');
if (ref.object.sha !== parentSha) {
  console.error(`远端 ${BRANCH}=${ref.object.sha}，本地 parent=${parentSha}：不是快进关系，改用 tools/push-via-api.mjs`);
  process.exit(2);
}
console.log(`本地 HEAD ${headSha.slice(0, 10)} / parent 已在远端 ${parentSha.slice(0, 10)}`);
console.log(message.split('\n')[0]);

/* 只取变更路径（相对 parent） */
const changed = gitt(['diff', '--name-only', parentSha, headSha]).trim().split('\n').filter(Boolean);
console.log('变更文件：', changed.join(', '));
process.stdout.write('- 上传 blob ');

const entries = [];
for (const path of changed) {
  const sha = gitt(['rev-parse', `${headSha}:${path}`]).trim();
  const mode = gitt(['ls-tree', headSha, '--', path]).trim().split(' ')[0];
  const b64 = git(['cat-file', 'blob', sha]).toString('base64');
  const r = await api('POST', '/git/blobs', { content: b64, encoding: 'base64' }, `blob ${path}`);
  if (r.sha !== sha) throw new Error(`blob SHA 不一致 ${path}`);
  entries.push({ path, mode, type: 'blob', sha });
  process.stdout.write('.');
}
console.log(' ok');

const treeRes = await api('POST', '/git/trees', { base_tree: gitt(['rev-parse', `${parentSha}^{tree}`]).trim(), tree: entries }, 'create tree');
if (treeRes.sha !== treeSha) throw new Error(`tree SHA 不一致：本地 ${treeSha} / 远端 ${treeRes.sha}`);
console.log('tree ok', treeRes.sha.slice(0, 10));

const commit = await api('POST', '/git/commits', {
  message, tree: treeSha, parents: [parentSha], author, committer,
}, 'create commit');
if (commit.sha !== headSha) throw new Error(`commit SHA 不一致：本地 ${headSha} / 远端 ${commit.sha}`);
console.log('commit ok', commit.sha.slice(0, 10));

await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: headSha, force: false }, 'update ref');
console.log(`\n✅ 已推送：refs/heads/${BRANCH} -> ${headSha}`);
