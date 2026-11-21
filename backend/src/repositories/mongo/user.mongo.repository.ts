import { randomUUID } from 'node:crypto';

import type { Collection, Db, MatchKeysAndValues } from 'mongodb';

import { ConflictError, NotFoundError } from '../../core/errors.js';
import type { User } from '../../domain/user.js';
import { Collections, isDuplicateKeyError } from '../../infra/mongo.js';
import type { CreateUserData, PageQuery, Paginated, UpdateUserData, UserRepository } from '../types.js';
import type { UserDoc } from './documents.js';
import { toDomainUser } from './mappers.js';

/**
 * MongoDB-backed UserRepository.
 *
 * Note what is NOT here: no "check if the email exists, then insert". That
 * read-then-write is a race - two concurrent registrations both see the address
 * as free, and both insert. Instead we let the unique index on `email` be the
 * arbiter and translate its violation (E11000) into our ConflictError. The
 * database is the only component that can make this decision atomically, so it
 * is the component that should make it.
 *
 * That index is declared in infra/mongo.ts and created at boot. Without it this
 * class silently loses its uniqueness guarantee - Mongo will happily store two
 * identical emails and nothing will complain until a user cannot log in.
 */
export class MongoUserRepository implements UserRepository {
  private readonly users: Collection<UserDoc>;

  constructor(db: Db) {
    this.users = db.collection<UserDoc>(Collections.USERS);
  }

  private static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async create(data: CreateUserData): Promise<User> {
    const now = new Date();

    const doc: UserDoc = {
      _id: randomUUID(),
      email: MongoUserRepository.normaliseEmail(data.email),
      passwordHash: data.passwordHash,
      name: data.name,
      role: data.role,
      isActive: true,
      dailySmsLimit: data.dailySmsLimit,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.users.insertOne(doc);
      return toDomainUser(doc);
    } catch (error) {
      // The unique index fired. Two requests raced; this one lost.
      if (isDuplicateKeyError(error)) {
        throw new ConflictError('An account with that email already exists');
      }
      throw error;
    }
  }

  async findById(id: string): Promise<User | null> {
    const doc = await this.users.findOne({ _id: id });
    return doc ? toDomainUser(doc) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const doc = await this.users.findOne({ email: MongoUserRepository.normaliseEmail(email) });
    return doc ? toDomainUser(doc) : null;
  }

  async update(id: string, data: UpdateUserData): Promise<User> {
    // Only the keys the caller actually supplied. Spreading `data` wholesale
    // would write `undefined` over untouched fields - which Mongo stores as a
    // literal null rather than ignoring.
    const changes: MatchKeysAndValues<UserDoc> = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.role !== undefined ? { role: data.role } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      ...(data.dailySmsLimit !== undefined ? { dailySmsLimit: data.dailySmsLimit } : {}),
      ...(data.passwordHash !== undefined ? { passwordHash: data.passwordHash } : {}),
      ...(data.lastLoginAt !== undefined ? { lastLoginAt: data.lastLoginAt } : {}),
      updatedAt: new Date(),
    };

    const doc = await this.users.findOneAndUpdate({ _id: id }, { $set: changes }, { returnDocument: 'after' });

    if (!doc) {
      throw new NotFoundError('User');
    }

    return toDomainUser(doc);
  }

  async delete(id: string): Promise<void> {
    const result = await this.users.deleteOne({ _id: id });

    if (result.deletedCount === 0) {
      throw new NotFoundError('User');
    }
  }

  async list(query: PageQuery): Promise<Paginated<User>> {
    // $facet, not two round-trips: it runs the page and the count as one
    // operation over one view of the data. Issuing find() and countDocuments()
    // separately lets a concurrent insert land between them, so `total` would
    // disagree with `items` and the dashboard's pagination would flicker.
    const [result] = await this.users
      .aggregate<{ items: UserDoc[]; total: { value: number }[] }>([
        {
          $facet: {
            items: [{ $sort: { createdAt: -1 } }, { $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
            total: [{ $count: 'value' }],
          },
        },
      ])
      .toArray();

    return {
      items: (result?.items ?? []).map(toDomainUser),
      // $count emits no row at all for an empty collection, so an absent entry
      // means zero.
      total: result?.total[0]?.value ?? 0,
    };
  }

  async count(): Promise<number> {
    return this.users.countDocuments();
  }
}
