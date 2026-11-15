import { describe, expect, it } from 'vitest';
import { decideSocialSyncGeneration } from './social.sync.generation.policy';

describe('decideSocialSyncGeneration', () => {
  it('rejects invalid, non-positive and unsafe generations', () => {
    for (const generation of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decideSocialSyncGeneration(null, generation, 'upsert')).toMatchObject({
        allowed: false,
        reason: 'invalid_generation',
      });
    }
  });

  it('allows a first generation and requests an insert', () => {
    expect(decideSocialSyncGeneration(null, 1, 'upsert')).toEqual({
      allowed: true,
      currentGeneration: 1,
      shouldInsert: true,
      shouldAdvance: false,
      replayed: false,
    });
  });

  it('allows a higher generation and requests an advance', () => {
    expect(decideSocialSyncGeneration(
      { generation: 4, lastAction: 'upsert' },
      5,
      'disconnect'
    )).toEqual({
      allowed: true,
      currentGeneration: 5,
      shouldInsert: false,
      shouldAdvance: true,
      replayed: false,
    });
  });

  it('rejects stale generations without allowing a write', () => {
    expect(decideSocialSyncGeneration(
      { generation: 8, lastAction: 'disconnect' },
      7,
      'upsert'
    )).toMatchObject({
      allowed: false,
      currentGeneration: 8,
      reason: 'superseded',
    });
  });

  it('allows an identical generation/action replay idempotently', () => {
    expect(decideSocialSyncGeneration(
      { generation: 8, lastAction: 'upsert' },
      8,
      'upsert'
    )).toEqual({
      allowed: true,
      currentGeneration: 8,
      shouldInsert: false,
      shouldAdvance: false,
      replayed: true,
    });
  });

  it('rejects a same-generation conflicting disconnect/reconnect action', () => {
    expect(decideSocialSyncGeneration(
      { generation: 8, lastAction: 'disconnect' },
      8,
      'upsert'
    )).toMatchObject({
      allowed: false,
      currentGeneration: 8,
      reason: 'conflict',
    });
  });
});
