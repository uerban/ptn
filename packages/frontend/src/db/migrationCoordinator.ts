import type { Transaction } from "dexie";

/**
 * Dexie schema snippet for a single version: table → index spec (or `null` to drop).
 * Mirrors the shape accepted by `db.version(n).stores(...)`.
 */
export type StoreSchema = Record<string, string | null>;

export interface MigrationDeclaration {
  readonly id: string;
  readonly version: number;
  readonly stores: StoreSchema;
  readonly upgrade?: (tx: Transaction) => Promise<void>;
}

/**
 * Central ledger for Dexie schema versions so subsystems (poiIndex, installKey,
 * encryptedRecents, …) cannot silently claim the same version number.
 * Collisions throw at registration time, which runs at module load — making
 * this the build-time guard the plan calls for.
 */
export class MigrationCoordinator {
  private readonly byVersion = new Map<number, MigrationDeclaration>();

  reserve(decl: MigrationDeclaration): void {
    if (!Number.isInteger(decl.version)) {
      throw new Error(
        `MigrationCoordinator: version must be an integer, got ${decl.version} for "${decl.id}"`,
      );
    }
    if (decl.version < 1) {
      throw new Error(
        `MigrationCoordinator: version must be >= 1, got ${decl.version} for "${decl.id}"`,
      );
    }
    const existing = this.byVersion.get(decl.version);
    if (existing) {
      if (existing.id === decl.id) return;
      throw new Error(
        `MigrationCoordinator: version ${decl.version} collision — already reserved by "${existing.id}", tried to reserve for "${decl.id}"`,
      );
    }
    this.byVersion.set(decl.version, decl);
  }

  declaredMigrations(): MigrationDeclaration[] {
    return [...this.byVersion.values()].sort((a, b) => a.version - b.version);
  }
}

export const migrationCoordinator = new MigrationCoordinator();
