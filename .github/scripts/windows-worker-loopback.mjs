import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function startInvoiceWorker({source, baseSource, fixedSource, script, check}) {
  const model = 'mosaic-windows-invoice-fixture';
  const key = 'mosaic-fixture-' + randomUUID();
  const requests = [], failures = [];
  const expected = ['reject-invoice-edit', 'repair-invoice'];
  const server = createServer(async (request, response) => {
    const index = requests.push({method:request.method, path:request.url}) - 1;
    response.setHeader('content-type','application/json');
    try {
      assert.equal(request.method,'POST');
      assert.equal(request.url,'/v1/chat/completions');
      assert.ok(request.headers.authorization === 'Bearer '+key,'Missing or incorrect private fixture credential');
      assert.ok(index < expected.length,'Unexpected additional worker call');
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        assert.ok(length <= 65536,'Request exceeds the fixture limit');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model,model);
      assert.equal(body.stream,false);
      const {task,inventory,attempt} = JSON.parse(body.messages.at(-1).content);
      assert.equal(task.submissionId,expected[index]);
      assert.equal(task.actor,'deepseek');
      assert.equal(task.kind,'coding');
      assert.equal(attempt,1);
      assert.deepEqual(task.permissions.writePaths,[source]);
      assert.equal(inventory.find(file => file.path === source)?.hash,hash(baseSource));
      assert.equal(inventory.find(file => file.path === script)?.hash,hash(check));
      requests[index].task = task.submissionId;
      const edits = [{path:source,action:'write',baseHash:hash(baseSource),content:fixedSource}];
      if (index === 0) edits.push({path:script,action:'write',baseHash:hash(check),content:'// Remove the test\n'});
      const content = JSON.stringify({type:'submit_changes',paths:[],edits,summary:'Offline fixture proposed an invoice repair'});
      response.end(JSON.stringify({model,choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}));
    } catch (error) {
      failures.push(error.message);
      response.writeHead(400).end(JSON.stringify({error:{message:'Unexpected offline fixture request'}}));
    }
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {
    model, key, requests, failures,
    url:`http://127.0.0.1:${server.address().port}/v1`,
    [Symbol.asyncDispose]() {
      return new Promise((resolve,reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
