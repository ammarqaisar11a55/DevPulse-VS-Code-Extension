import { describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/auth/credentialStore';
import { StateStore } from '../../src/storage/stateStore';
import { MemoryMemento, MemorySecrets } from './helpers';

describe('CredentialStore', () => {
  it('stores the credential in secret storage only', async () => {
    const secrets = new MemorySecrets();
    const store = new CredentialStore(secrets);
    expect(await store.get()).toBeUndefined();
    await store.set('dpd_abc');
    expect(await store.get()).toBe('dpd_abc');
    expect([...secrets.values.values()]).toEqual(['dpd_abc']);
    await store.clear();
    expect(await store.get()).toBeUndefined();
    expect(secrets.values.size).toBe(0);
  });

  it('rejects values that are not device credentials', async () => {
    const store = new CredentialStore(new MemorySecrets());
    await expect(store.set('DP-AAAA-BBBB-CCCC')).rejects.toThrow();
  });

  it('re-reads the secret after invalidation', async () => {
    const secrets = new MemorySecrets();
    const store = new CredentialStore(secrets);
    await store.get();
    await secrets.store('devpulse.deviceCredential', 'dpd_other');
    expect(await store.get()).toBeUndefined();
    store.invalidate();
    expect(await store.get()).toBe('dpd_other');
  });
});

describe('StateStore', () => {
  it('reads and writes typed global and workspace values', async () => {
    const state = new StateStore(new MemoryMemento(), new MemoryMemento());
    await state.setGlobal('devpulse.trackingPaused', true);
    await state.setWorkspace('devpulse.currentSessionId', 'abc');
    expect(state.getGlobal('devpulse.trackingPaused')).toBe(true);
    expect(state.getWorkspace('devpulse.currentSessionId')).toBe('abc');
    await state.setGlobal('devpulse.trackingPaused', undefined);
    expect(state.getGlobal('devpulse.trackingPaused')).toBeUndefined();
  });
});
