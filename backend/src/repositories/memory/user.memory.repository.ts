import { randomUUID } from 'node:crypto';

import { ConflictError, NotFoundError } from '../../core/errors.js';
import type { User } from '../../domain/user.js';
import type { CreateUserData, PageQuery, Paginated, UpdateUserData, UserRepository } from '../types.js';

/**
 * In-memory UserRepository.
 *
 * The test store. It is not a mock - it enforces the same invariants MongoDB
 * does (unique email, case-insensitive lookup, immutable createdAt), so the
 * services and tests written against it stay honest against the real database.
 * Anything this implementation lets slide would become a production bug the day
 * the real store refuses it - which is why the contract suite runs the same
 * assertions against both.
 *
 * Records are cloned on the way out so a caller cannot mutate the store by
 * holding a reference - the same isolation a real database gives you for free.
 */

/** Free functions, not static methods: safe to pass to `.map()` without losing `this`. */
function clone(user: User): User {
  return { ...user };
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();
  /** email (lowercased) -> id. Mirrors the unique index MongoDB carries. */
  private readonly emailIndex = new Map<string, string>();

  async create(data: CreateUserData): Promise<User> {
    const email = normaliseEmail(data.email);

    if (this.emailIndex.has(email)) {
      throw new ConflictError('An account with that email already exists');
    }

    const now = new Date();
    const user: User = {
      id: randomUUID(),
      email,
      passwordHash: data.passwordHash,
      name: data.name,
      role: data.role,
      isActive: true,
      dailySmsLimit: data.dailySmsLimit,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.byId.set(user.id, user);
    this.emailIndex.set(email, user.id);

    return Promise.resolve(clone(user));
  }

  findById(id: string): Promise<User | null> {
    const user = this.byId.get(id);
    return Promise.resolve(user ? clone(user) : null);
  }

  findByEmail(email: string): Promise<User | null> {
    const id = this.emailIndex.get(normaliseEmail(email));
    if (!id) return Promise.resolve(null);

    const user = this.byId.get(id);
    return Promise.resolve(user ? clone(user) : null);
  }

  // `async`, not a plain function returning Promise.resolve(). The distinction is
  // not cosmetic: a synchronous `throw` from a Promise-returning method explodes
  // at the call site instead of rejecting the promise, so `repo.update(...).catch(...)`
  // would work against MongoDB and crash against this store. The contract suite
  // caught exactly that. Async makes every throw a rejection, as callers expect.
  // eslint-disable-next-line @typescript-eslint/require-await
  async update(id: string, data: UpdateUserData): Promise<User> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new NotFoundError('User');
    }

    const updated: User = {
      ...existing,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.role !== undefined ? { role: data.role } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      ...(data.dailySmsLimit !== undefined ? { dailySmsLimit: data.dailySmsLimit } : {}),
      ...(data.passwordHash !== undefined ? { passwordHash: data.passwordHash } : {}),
      ...(data.lastLoginAt !== undefined ? { lastLoginAt: data.lastLoginAt } : {}),
      updatedAt: new Date(),
    };

    this.byId.set(id, updated);
    return clone(updated);
  }

  // Async for the same reason as update(): a throw must reject, not explode.
  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(id: string): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new NotFoundError('User');
    }

    this.byId.delete(id);
    this.emailIndex.delete(existing.email);
  }

  list(query: PageQuery): Promise<Paginated<User>> {
    const all = [...this.byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const start = (query.page - 1) * query.limit;

    return Promise.resolve({
      items: all.slice(start, start + query.limit).map(clone),
      total: all.length,
    });
  }

  count(): Promise<number> {
    return Promise.resolve(this.byId.size);
  }

  /** Test helper. Not part of the port - Phase 3 will not implement it. */
  clear(): void {
    this.byId.clear();
    this.emailIndex.clear();
  }
}
