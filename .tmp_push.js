// Push the whole working tree to GitHub via the Git Data API (git:// and https git
// protocol are timing out on this network, but api.github.com works).
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'xinqian136';
const REPO = 'drift-town';
const BRANCH = 'main';
const ROOT = process.cwd();

function api(method, urlPath, body) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method: method,
      headers: Object.assign({
        'Authorization': 'token ' + TOKEN,
        'User-Agent': 'dsh-drift-town-push',
        'Accept': 'application/vnd.github+json',
        'Content-Length': data ? Buffer.byteLength(data) : 0
      }, data ? { 'Content-Type': 'application/json' } : {})
    }, function (res) {
      let chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(chunks ? JSON.parse(chunks) : {}); }
          catch (e) { resolve(chunks); }
        } else {
          reject(new Error(method + ' ' + urlPath + ' -> ' + res.statusCode + ': ' + chunks.slice(0, 400)));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Files that must not be pushed (mirrors .gitignore).
const SKIP_DIRS = ['.git', '.studio', 'node_modules', 'prototype/dive/shots'];
const SKIP_FILES = ['prototype/dive/selftest.json', 'prototype/dive/touchtest.json'];

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.indexOf(rel) >= 0) return;
      walk(full, out);
    } else {
      if (SKIP_FILES.indexOf(rel) >= 0) return;
      out.push({ rel: rel, full: full });
    }
  });
  return out;
}

function isBinary(rel) {
  return /\.(png|jpe?g|gif|webp|ico|mp3|wav|ogg|woff2?|ttf|zip|tgz)$/i.test(rel);
}

(async function main() {
  const files = walk(ROOT, []);
  console.log('本地文件数: ' + files.length);

  // 1. Current branch head (to use as parent, and to know whether the tree changed).
  let parentSha = null;
  try {
    const br = await api('GET', '/repos/' + OWNER + '/' + REPO + '/branches/' + BRANCH);
    parentSha = br.commit.sha;
    console.log('远端当前 HEAD: ' + parentSha.slice(0, 7) + ' - ' + br.commit.commit.message.split('\n')[0]);
  } catch (e) {
    console.log('远端分支不存在或读取失败, 将创建首个提交');
  }

  // 2. Upload blobs.
  const treeItems = [];
  let uploaded = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    let blobSha;
    if (isBinary(f.rel)) {
      const b = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
        content: buf.toString('base64'), encoding: 'base64'
      });
      blobSha = b.sha;
    } else {
      // Text: send as base64 too, so encoding is preserved exactly.
      const b = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
        content: buf.toString('base64'), encoding: 'base64'
      });
      blobSha = b.sha;
    }
    treeItems.push({ path: f.rel, mode: '100644', type: 'blob', sha: blobSha });
    uploaded++;
    if (uploaded % 10 === 0) console.log('  已上传 ' + uploaded + '/' + files.length + ' 个文件');
  }
  console.log('全部 blobs 上传完成: ' + uploaded + ' 个');

  // 3. Tree.
  const tree = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', { tree: treeItems });
  console.log('tree 创建: ' + tree.sha.slice(0, 7));

  // 4. Commit.
  const message = fs.readFileSync('.tmp_commit_msg.txt', 'utf8');
  const commitBody = { message: message, tree: tree.sha, parents: parentSha ? [parentSha] : [] };
  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', commitBody);
  console.log('commit 创建: ' + commit.sha.slice(0, 7));

  // 5. Move the branch.
  if (parentSha) {
    await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: true });
  } else {
    await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/refs', { ref: 'refs/heads/' + BRANCH, sha: commit.sha });
  }
  console.log('分支已更新到 ' + commit.sha.slice(0, 7));
  console.log('DONE ' + commit.sha);
})().catch(function (e) {
  console.error('FAILED: ' + e.message);
  process.exit(1);
});
