import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../', import.meta.url);
const uri = (path, replacements = []) => {
  let source = readFileSync(new URL(path, root), 'utf8');
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  return 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64');
};
const textUri = uri('supabase/functions/_shared/arisa-speech-text.ts');
const { synthesize, SPEECH_ERRORS } = await import(uri('supabase/functions/_shared/arisa-speech.ts', [['"./arisa-speech-text.ts"', JSON.stringify(textUri)]]));

test('403/404 model denial gives an actionable permission error, not a temporary failure', async () => {
  for (const status of [403, 404]) {
    let requests = 0;
    await assert.rejects(synthesize('Mensagem de teste.', 'synthetic-key', async () => {
      requests++;
      return Response.json({ error: { code: 'model_not_found', type: 'invalid_request_error', message: 'Project private-project does not have access. synthetic-key' } }, { status });
    }), error => {
      assert.equal(error.code, 'SPEECH_MODEL_ACCESS');
      assert.equal(error.status, 403);
      assert.match(SPEECH_ERRORS[error.code], /gpt-4o-mini-tts/);
      assert.match(SPEECH_ERRORS[error.code], /Limits.*Model usage/);
      assert.doesNotMatch(JSON.stringify(error) + SPEECH_ERRORS[error.code], /private-project|synthetic-key/);
      return true;
    });
    assert.equal(requests, 1, 'Permission denial must never trigger fallback or repeated spending');
  }
});
test('other forbidden responses explain credential permissions without disclosing the provider body', async () => {
  await assert.rejects(synthesize('Teste', 'synthetic-key', async () => Response.json({ error: { code: 'insufficient_permissions', message: 'private credential policy' } }, { status: 403 })), error => {
    assert.equal(error.code, 'SPEECH_PROVIDER_PERMISSION');
    assert.doesNotMatch(SPEECH_ERRORS[error.code], /private credential/);
    return true;
  });
});
test('malformed errors and untrusted error text stay generic; a message alone cannot set the code', async () => {
  for (const body of ['private-provider-data', '{', JSON.stringify({ error: { message: 'model_not_found' } })]) {
    await assert.rejects(synthesize('Teste', 'synthetic-key', async () => new Response(body, { status: 404 })), /SPEECH_UNAVAILABLE/);
  }
});
test('model error bodies are bounded and the stream is cancelled', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(9000)); }, cancel() { cancelled = true; } });
  await assert.rejects(synthesize('Teste', 'synthetic-key', async () => new Response(body, { status: 404 })), /SPEECH_UNAVAILABLE/);
  assert.equal(cancelled, true);
});
test('permission-looking codes on transient server failures do not falsely require reconfiguration', async () => {
  await assert.rejects(synthesize('Teste', 'synthetic-key', async () => Response.json({ error: { code: 'model_not_found' } }, { status: 500 })), /SPEECH_UNAVAILABLE/);
});
test('rate limits and successful MP3 responses preserve the existing API contract', async () => {
  await assert.rejects(synthesize('Teste', 'synthetic-key', async () => new Response('private-provider-data', { status: 429 })), error => error.code === 'SPEECH_LIMIT' && error.status === 429);
  const bytes = await synthesize('Bom dia.', 'synthetic-key', async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/speech');
    const data = JSON.parse(request.body);
    assert.equal(data.model, 'gpt-4o-mini-tts'); assert.equal(data.voice, 'coral'); assert.equal(data.speed, 0.96);
    assert.match(data.instructions, /profissional, delicada, doce/);
    return new Response(new Uint8Array(128), { headers: { 'content-type': 'audio/mpeg' } });
  });
  assert.equal(bytes.byteLength, 128);
});
