# 1Password Integration — NestJS Implementation Guide

> **Who this is for.** A NestJS agent implementing the server side of the
> Nabu 1Password integration. Self-contained — you should not need to read
> any OpenClaw source to implement this, only to understand how the two
> halves connect at the contract boundary.
>
> **Status.** OpenClaw side is fully implemented and merged on our fork.
> This document describes what you must build on `va-core-nest` to make
> the integration work end-to-end.

---

## 1. What this integration does

Each Nabu organization runs its own Dockerized OpenClaw instance. Org admins
connect their **own** 1Password account (bring-your-own) via a Nabu dashboard
page. Nabu stores the 1Password service-account token encrypted at rest, and
pushes an **opaque bearer** to the tenant's OpenClaw instance over the
existing WebSocket RPC (same path that already pushes SMTP tokens). The
OpenClaw plugin uses that bearer to fetch the raw `ops_...` token from
NestJS at activation, sets it in `process.env`, and the tenant's agents can
then transparently use the `op` CLI (`op read`, `op inject`, `op run`).

Result: the raw 1P token exists:

- **Encrypted** in the Nabu DB (AES-256-GCM).
- **Briefly decrypted** in NestJS memory during the skill-callback response.
- **In the gateway process `process.env`** on the tenant's container
  (memory-only, never on disk, never in `openclaw.json`).

Nowhere else.

## 2. Why this shape

Two constraints drove the design:

1. **OpenClaw's exec-approvals layer strips per-call env overrides on shell
   wrappers** (`bash -c`, `sh -c`) down to a tiny allowlist (`TERM, LANG,
LC_*, COLORTERM, NO_COLOR, FORCE_COLOR`). This means the token can't be
   injected per-invocation via hooks — it must already be in `process.env`
   when exec children spawn. Hence the plugin sets it at `gateway_start`.

2. **`openclaw.json` is prompt-extractable.** An agent with filesystem
   access can read its own config and return it. Therefore the raw `ops_`
   cannot be pushed into `openclaw.json` via `config.patch`. Only the
   **opaque `apiToken`** (which on its own is useless — see §6.3) lives in
   config.

The resulting flow mirrors the existing `nabu-email` pattern with one
extension: the skill-callback endpoint returns the raw `ops_` token (not a
send/fetch result), gated by a **two-factor auth** (`x-skill-token` +
`x-organization-id`).

## 3. End-to-end flow

```
  ┌──────────────────────┐
  │    Dashboard UI      │
  └──────────┬───────────┘
             │  POST /api/v1/onepassword/config { serviceAccountToken, defaultVaultId? }
             ▼
  ┌──────────────────────────────────────────────────────────┐
  │  NestJS apps/app                                          │
  │  • OnePasswordController                                   │
  │  • OnePasswordService                                      │
  │    - verifyToken() via @1password/sdk                      │
  │    - AES-256-GCM encrypt                                   │
  │    - persist OrganizationOnePasswordConfigEntity           │
  │    - generate opaque apiToken (32-byte hex)                │
  │    - OpenClawRmqClient.setOnePasswordPluginToken(orgId, …) │
  └──────────┬───────────────────────────────────────────────┘
             │  RabbitMQ (Exchanges.NabuRpc, routingKey=orgId)
             ▼
  ┌──────────────────────────────────────────────────────────┐
  │  NestJS apps/nabu-gateway                                 │
  │  • OpenClawRpcController handles one-password-plugin.*   │
  │  • connection.rpc('config.patch', {…nabu-1password…})    │
  │  • connection.rpc('nabu.onepassword.refresh', {})        │
  └──────────┬───────────────────────────────────────────────┘
             │  WebSocket to the tenant's OpenClaw gateway
             ▼
  ┌──────────────────────────────────────────────────────────┐
  │  OpenClaw gateway (per-org Docker)                        │
  │  • nabu-1password plugin                                   │
  │    - reads apiToken from openclaw.json (live)              │
  │    - POST /api/v1/onepassword/token to NestJS             │
  │      headers: x-skill-token, x-organization-id            │
  │    - sets process.env.OP_SERVICE_ACCOUNT_TOKEN             │
  │    - periodic 6h refresh + on-rotation refresh RPC         │
  └──────────────────────────────────────────────────────────┘
             │  op read / inject / run — inherits process.env
             ▼
                      my.1password.com
```

## 4. The contract (read this first — everything else derives from it)

The OpenClaw plugin at `extensions/nabu-1password/index.ts` (in our
`va-openclaw` repo) calls exactly one endpoint on NestJS:

### POST `/api/v1/onepassword/token`

**Auth:** two headers, both required:

| Header              | Purpose                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `x-skill-token`     | Per-org opaque bearer (32-byte hex). Rotated on upsert or rotate call.   |
| `x-organization-id` | Numeric org id. Lives in docker-compose env, **not** in `openclaw.json`. |

Look up the config row by **both** fields matched against the same record.
If either is missing or wrong → 401. If both match → return the decrypted
service-account token.

**Request body:** `{}` (JSON). Reserved for future use; plugin currently
sends empty object.

**Response 200:**

```json
{ "token": "ops_..." }
```

**Response 401:** `{ "error": "Invalid skill credentials" }`

**Internal-only.** This route must not be reachable from the public
internet. It's called from the org's OpenClaw container via the Docker
bridge network at `http://app:6001/api/v1/onepassword/token`.

Also exposes (dashboard-only, JWT-authed):

| Method | Path                                    | Body                                       | Returns                              |
| ------ | --------------------------------------- | ------------------------------------------ | ------------------------------------ |
| POST   | `/api/v1/onepassword/config`            | `{ serviceAccountToken, defaultVaultId? }` | `{ apiKey }` (one-time)              |
| GET    | `/api/v1/onepassword/config`            | —                                          | `OnePasswordConfigMeta` (no secrets) |
| POST   | `/api/v1/onepassword/config/test`       | —                                          | `OnePasswordTestResult`              |
| POST   | `/api/v1/onepassword/config/rotate-key` | —                                          | `{ apiKey }` (one-time)              |
| DELETE | `/api/v1/onepassword/config`            | —                                          | 204                                  |

## 5. File-by-file implementation

Mirror the existing `SmtpModule` layout exactly. Everything that looks like
it could be copy-paste from SMTP, is — with the encryption salt changed to
prevent cross-integration decrypt.

### 5.1 Entity

**Path:** `libs/database/src/entities/organization-one-password-config.entity.ts`

```ts
import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "@app/database/entities/base/base.entity";
import { OrganizationEntity } from "@app/database/entities/organization.entity";
import { DbStatus } from "@app/shared/utils/enums";

@Entity("app_organization_one_password_configs")
export class OrganizationOnePasswordConfigEntity extends BaseEntity {
  @Column({ name: "organization_id", type: "int", unique: true })
  organizationId: number;

  /** AES-256-GCM ciphertext stored as JSON: { iv, tag, ciphertext } (all hex) */
  @Column({ name: "service_account_token_encryption", type: "text" })
  serviceAccountTokenEncryption: string;

  /** SHA-256 hex of the raw bearer issued to the OpenClaw skill */
  @Column({ name: "api_key_hash", type: "varchar", unique: true })
  apiKeyHash: string;

  /** First 12 hex of sha256(ops_) — for audit display only, never the raw token */
  @Column({ name: "token_fingerprint", type: "varchar", length: 12, nullable: true })
  tokenFingerprint: string | null;

  /** Optional default vault UUID or name — UX hint, not enforced at resolve time */
  @Column({ name: "default_vault_id", type: "varchar", length: 64, nullable: true })
  defaultVaultId: string | null;

  @Column({ name: "last_validated_at", type: "timestamptz", nullable: true })
  lastValidatedAt: Date | null;

  @Column({ name: "last_validation_error", type: "text", nullable: true })
  lastValidationError: string | null;

  @ManyToOne(() => OrganizationEntity)
  @JoinColumn({ name: "organization_id" })
  organization: OrganizationEntity;

  get isActive(): boolean {
    return this.status === DbStatus.Active;
  }
}
```

### 5.2 Migration

**Path:** `libs/database/src/migrations/<timestamp>-create-organization-one-password-config.ts`

```ts
import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class CreateOrganizationOnePasswordConfig1700000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "app_organization_one_password_configs",
        columns: [
          {
            name: "id",
            type: "int",
            isPrimary: true,
            isGenerated: true,
            generationStrategy: "increment",
          },
          { name: "organization_id", type: "int", isUnique: true },
          { name: "service_account_token_encryption", type: "text" },
          { name: "api_key_hash", type: "varchar", isUnique: true },
          { name: "token_fingerprint", type: "varchar", length: "12", isNullable: true },
          { name: "default_vault_id", type: "varchar", length: "64", isNullable: true },
          { name: "last_validated_at", type: "timestamptz", isNullable: true },
          { name: "last_validation_error", type: "text", isNullable: true },
          { name: "status", type: "smallint", default: 1 },
          { name: "created_at", type: "timestamptz", default: "now()" },
          { name: "updated_at", type: "timestamptz", default: "now()" },
        ],
        foreignKeys: [
          {
            columnNames: ["organization_id"],
            referencedTableName: "app_organizations",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("app_organization_one_password_configs");
  }
}
```

Confirm the migration timestamp and exact table constraints against your
existing migration-naming convention.

### 5.3 Interface

**Path:** `apps/app/src/integrations/one-password/one-password.interface.ts`

```ts
export interface EncryptedValue {
  iv: string; // hex
  tag: string; // hex
  ciphertext: string; // hex
}

export interface OnePasswordConfigMeta {
  tokenFingerprint: string | null;
  defaultVaultId: string | null;
  lastValidatedAt: Date | null;
  configured: boolean;
  configuredAt: Date | null;
}

export interface OnePasswordTestResult {
  healthy: boolean;
  vaults?: { id: string; name: string }[];
  error?: string;
}
```

### 5.4 DTOs

**Path:** `apps/app/src/integrations/one-password/one-password.dtos.ts`

```ts
import { IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpsertOnePasswordConfigDto {
  @ApiProperty({ description: "1Password service-account token — starts with ops_" })
  @IsString()
  @Matches(/^ops_[A-Za-z0-9_\-]+$/, { message: "Token must start with ops_" })
  @MaxLength(2048)
  serviceAccountToken: string;

  @ApiPropertyOptional({ description: "Optional default vault UUID or name to validate against" })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  defaultVaultId?: string;
}
```

### 5.5 Encryption service

**Path:** `apps/app/src/integrations/one-password/one-password-encryption.service.ts`

**CRITICAL:** Use salt `'nabu-op-v1'`. This **must differ** from
`SmtpEncryptionService`'s `'va-team-smtp-enc-v1'` so the derived keys are
distinct — prevents cross-integration decrypt in case of a bug.

```ts
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { EncryptedValue } from "./one-password.interface";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT = "nabu-op-v1"; // must differ from SMTP's salt

@Injectable()
export class OnePasswordEncryptionService {
  private readonly logger = new Logger(OnePasswordEncryptionService.name);
  private readonly key: Buffer;

  constructor(private readonly config: ConfigService) {
    const appSecret = this.config.getOrThrow<string>("APP_SECRET");
    this.key = scryptSync(appSecret, SALT, KEY_LEN, { N: 16384, r: 8, p: 1 }) as Buffer;
    this.logger.log("OnePasswordEncryptionService: key derived from APP_SECRET");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_LEN });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const value: EncryptedValue = {
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    };
    return JSON.stringify(value);
  }

  decrypt(encryptedJson: string): string {
    const { iv, tag, ciphertext } = JSON.parse(encryptedJson) as EncryptedValue;
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, "hex"), {
      authTagLength: TAG_LEN,
    });
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "hex")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }
}
```

### 5.6 Service

**Path:** `apps/app/src/integrations/one-password/one-password.service.ts`

```ts
import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { createHash, randomBytes } from "crypto";
import { createClient } from "@1password/sdk";
import { OrganizationOnePasswordConfigEntity } from "@app/database/entities/organization-one-password-config.entity";
import { OnePasswordEncryptionService } from "./one-password-encryption.service";
import { UpsertOnePasswordConfigDto } from "./one-password.dtos";
import { OnePasswordConfigMeta, OnePasswordTestResult } from "./one-password.interface";
import { OpenClawRmqClient } from "@/integrations/openclaw-rmq";

@Injectable()
export class OnePasswordService {
  private readonly logger = new Logger(OnePasswordService.name);

  constructor(
    @InjectRepository(OrganizationOnePasswordConfigEntity)
    private readonly repo: Repository<OrganizationOnePasswordConfigEntity>,
    private readonly encryption: OnePasswordEncryptionService,
    private readonly openclawRmq: OpenClawRmqClient,
  ) {}

  // ---- Dashboard (JWT-authed) ------------------------------------------------

  async upsertConfig(
    organizationId: number,
    dto: UpsertOnePasswordConfigDto,
  ): Promise<{ apiKey: string }> {
    const testResult = await this.verifyToken(dto.serviceAccountToken, dto.defaultVaultId);
    if (!testResult.healthy) {
      throw new HttpException(
        { error: `1Password token validation failed: ${testResult.error ?? "unknown error"}` },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const rawApiKey = randomBytes(32).toString("hex");
    const apiKeyHash = createHash("sha256").update(rawApiKey).digest("hex");

    const existing = await this.repo.findOne({ where: { organizationId } });
    const entity = existing ?? this.repo.create({ organizationId });

    entity.serviceAccountTokenEncryption = this.encryption.encrypt(dto.serviceAccountToken);
    entity.apiKeyHash = apiKeyHash;
    entity.tokenFingerprint = this.fingerprint(dto.serviceAccountToken);
    entity.defaultVaultId = dto.defaultVaultId ?? null;
    entity.lastValidatedAt = new Date();
    entity.lastValidationError = null;

    await this.repo.save(entity);

    void this.pushTokenToGateway(organizationId, rawApiKey);
    this.logger.log(`1Password config saved for organization ${organizationId}`);
    return { apiKey: rawApiKey };
  }

  async getConfigMeta(organizationId: number): Promise<OnePasswordConfigMeta> {
    const config = await this.repo.findOne({ where: { organizationId } });
    if (!config) {
      return {
        tokenFingerprint: null,
        defaultVaultId: null,
        lastValidatedAt: null,
        configured: false,
        configuredAt: null,
      };
    }
    return {
      tokenFingerprint: config.tokenFingerprint,
      defaultVaultId: config.defaultVaultId,
      lastValidatedAt: config.lastValidatedAt,
      configured: true,
      configuredAt: config.updatedAt,
    };
  }

  async deleteConfig(organizationId: number): Promise<void> {
    await this.repo.delete({ organizationId });
    // Push empty token to gateway — the RPC handler interprets this as
    // "disable plugin" and sets plugins.entries.nabu-1password.enabled=false.
    void this.pushTokenToGateway(organizationId, "");
    this.logger.log(`1Password config deleted for organization ${organizationId}`);
  }

  async testExistingConfig(organizationId: number): Promise<OnePasswordTestResult> {
    const config = await this.findConfigOrThrow(organizationId);
    const token = this.encryption.decrypt(config.serviceAccountTokenEncryption);
    const result = await this.verifyToken(token, config.defaultVaultId ?? undefined);
    config.lastValidatedAt = new Date();
    config.lastValidationError = result.healthy ? null : (result.error ?? "unknown");
    await this.repo.save(config);
    return result;
  }

  async rotateApiKey(organizationId: number): Promise<{ apiKey: string }> {
    const config = await this.findConfigOrThrow(organizationId);
    const rawApiKey = randomBytes(32).toString("hex");
    config.apiKeyHash = createHash("sha256").update(rawApiKey).digest("hex");
    await this.repo.save(config);
    void this.pushTokenToGateway(organizationId, rawApiKey);
    this.logger.log(`1Password API key rotated for organization ${organizationId}`);
    return { apiKey: rawApiKey };
  }

  // ---- Skill callback (bearer-authed, internal Docker network only) ----------

  /**
   * Resolves the raw `ops_` for the plugin. REQUIRES both matching apiKey AND
   * organizationId — this is the second factor that prevents a leaked apiKey
   * from being useful without also knowing the tenant's org id (which lives
   * in docker-compose env, not in openclaw.json).
   */
  async resolveOpsToken(rawApiKey: string, organizationId: number): Promise<string> {
    const hash = createHash("sha256").update(rawApiKey).digest("hex");
    const config = await this.repo.findOne({ where: { apiKeyHash: hash, organizationId } });
    if (!config) {
      throw new HttpException({ error: "Invalid skill credentials" }, HttpStatus.UNAUTHORIZED);
    }
    return this.encryption.decrypt(config.serviceAccountTokenEncryption);
  }

  // ---- Internal -------------------------------------------------------------

  private async findConfigOrThrow(
    organizationId: number,
  ): Promise<OrganizationOnePasswordConfigEntity> {
    const config = await this.repo.findOne({ where: { organizationId } });
    if (!config) {
      throw new HttpException(
        { error: "1Password not configured for this organization" },
        HttpStatus.NOT_FOUND,
      );
    }
    return config;
  }

  private fingerprint(token: string): string {
    return createHash("sha256").update(token).digest("hex").slice(0, 12);
  }

  private async verifyToken(
    token: string,
    expectedVaultId?: string,
  ): Promise<OnePasswordTestResult> {
    try {
      const client = await createClient({
        auth: token,
        integrationName: "Nabu",
        integrationVersion: "v1",
      });
      const vaults = await client.vaults.list();
      const normalized = vaults.map((v) => ({ id: v.id, name: v.title }));
      if (
        expectedVaultId &&
        !normalized.find((v) => v.id === expectedVaultId || v.name === expectedVaultId)
      ) {
        return {
          healthy: false,
          vaults: normalized,
          error: `Configured default vault "${expectedVaultId}" not accessible to this service account`,
        };
      }
      return { healthy: true, vaults: normalized };
    } catch (err) {
      return { healthy: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async pushTokenToGateway(organizationId: number, rawApiKey: string): Promise<void> {
    try {
      await this.openclawRmq.setOnePasswordPluginToken(organizationId, rawApiKey);
      this.logger.log(`1Password plugin token patched for organization ${organizationId}`);
    } catch (err) {
      this.logger.warn(
        `Could not push 1Password token to gateway for organization ${organizationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
```

### 5.7 Controller

**Path:** `apps/app/src/integrations/one-password/one-password.controller.ts`

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { OnePasswordService } from "./one-password.service";
import { UpsertOnePasswordConfigDto } from "./one-password.dtos";
import { Organization, Public, RequiresOrganization, User } from "@/modules/auth/decorators";
import { OrganizationEntity } from "@app/database/entities/organization.entity";
import { UserEntity } from "@app/database/entities/user.entity";

@ApiTags("1Password")
@Controller({ path: "onepassword", version: "1" })
export class OnePasswordController {
  constructor(private readonly onePasswordService: OnePasswordService) {}

  // ---- Dashboard (org-admin JWT) -------------------------------------------

  @ApiOperation({ summary: "Upsert the organization 1Password service-account token" })
  @ApiBearerAuth()
  @RequiresOrganization()
  @Post("config")
  @HttpCode(201)
  upsertConfig(
    @Body() dto: UpsertOnePasswordConfigDto,
    @User("user") _user: UserEntity,
    @Organization() organization: OrganizationEntity,
  ): Promise<{ apiKey: string }> {
    return this.onePasswordService.upsertConfig(organization.id, dto);
  }

  @ApiOperation({ summary: "Get non-sensitive 1Password config metadata" })
  @ApiBearerAuth()
  @RequiresOrganization()
  @Get("config")
  getConfig(@User("user") _user: UserEntity, @Organization() organization: OrganizationEntity) {
    return this.onePasswordService.getConfigMeta(organization.id);
  }

  @ApiOperation({ summary: "Test the stored 1Password token against the 1P API" })
  @ApiBearerAuth()
  @RequiresOrganization()
  @Post("config/test")
  @HttpCode(200)
  testConfig(@User("user") _user: UserEntity, @Organization() organization: OrganizationEntity) {
    return this.onePasswordService.testExistingConfig(organization.id);
  }

  @ApiOperation({ summary: "Rotate the OpenClaw skill API key (does not change the 1P token)" })
  @ApiBearerAuth()
  @RequiresOrganization()
  @Post("config/rotate-key")
  @HttpCode(200)
  rotateApiKey(@User("user") _user: UserEntity, @Organization() organization: OrganizationEntity) {
    return this.onePasswordService.rotateApiKey(organization.id);
  }

  @ApiOperation({ summary: "Delete 1Password config for the organization" })
  @ApiBearerAuth()
  @RequiresOrganization()
  @Delete("config")
  @HttpCode(204)
  deleteConfig(
    @User("user") _user: UserEntity,
    @Organization() organization: OrganizationEntity,
  ): Promise<void> {
    return this.onePasswordService.deleteConfig(organization.id);
  }

  // ---- Skill callback (internal Docker network, bearer-authed) -------------

  @ApiOperation({
    summary: "[Skill] Resolve raw ops_ for the OpenClaw plugin",
    description:
      "Authenticated by the per-organization API key + organization id second factor. Internal-only — Docker network.",
  })
  @ApiHeader({ name: "x-skill-token", required: true })
  @ApiHeader({ name: "x-organization-id", required: true })
  @Public()
  @Post("token")
  @HttpCode(200)
  async getToken(
    @Headers("x-skill-token") rawApiKey: string,
    @Headers("x-organization-id") orgIdHeader: string,
  ): Promise<{ token: string }> {
    if (!rawApiKey?.trim()) {
      throw new HttpException({ error: "Missing x-skill-token" }, HttpStatus.UNAUTHORIZED);
    }
    const orgId = Number.parseInt(orgIdHeader ?? "", 10);
    if (!Number.isFinite(orgId) || orgId <= 0) {
      throw new HttpException(
        { error: "Missing or invalid x-organization-id" },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const token = await this.onePasswordService.resolveOpsToken(rawApiKey.trim(), orgId);
    return { token };
  }
}
```

### 5.8 Module + barrel

**Path:** `apps/app/src/integrations/one-password/one-password.module.ts`

```ts
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OrganizationOnePasswordConfigEntity } from "@app/database/entities/organization-one-password-config.entity";
import { OnePasswordEncryptionService } from "./one-password-encryption.service";
import { OnePasswordService } from "./one-password.service";
import { OnePasswordController } from "./one-password.controller";
import { OpenClawRmqModule } from "@/integrations/openclaw-rmq";

@Module({
  imports: [TypeOrmModule.forFeature([OrganizationOnePasswordConfigEntity]), OpenClawRmqModule],
  controllers: [OnePasswordController],
  providers: [OnePasswordEncryptionService, OnePasswordService],
  exports: [OnePasswordService],
})
export class OnePasswordModule {}
```

**Path:** `apps/app/src/integrations/one-password/index.ts`

```ts
export { OnePasswordModule } from "./one-password.module";
export { OnePasswordService } from "./one-password.service";
```

### 5.9 Register in `main.module.ts`

Open `apps/app/src/main.module.ts`, add the import near the existing
`SmtpModule` import (around line 28) and add to the `imports:` array
(around line 104):

```ts
import { OnePasswordModule } from './integrations/one-password';
// ...
@Module({
  imports: [
    // ... existing ...
    SmtpModule,
    OnePasswordModule,
    // ... existing ...
  ],
})
```

### 5.10 Extend `OpenClawRmqClient`

**Path:** `apps/app/src/integrations/openclaw-rmq/openclaw-rmq.client.ts`

Add one method after `setEmailPluginToken`:

```ts
  /**
   * Asks nabu-gateway to write the rotated 1Password plugin bearer token
   * into the organization's OpenClaw config. Empty `apiToken` disables the
   * plugin. Routed on `organizationId` so a sharded gateway can pin the
   * tenant to the replica that owns its WebSocket.
   */
  async setOnePasswordPluginToken(organizationId: number, apiToken: string): Promise<void> {
    await this.amqp.request({
      exchange: Exchanges.NabuRpc,
      routingKey: String(organizationId),
      payload: {
        method: 'one-password-plugin.set-token',
        organizationId,
        params: { apiToken },
      },
      timeout: 15_000,
    });
  }
```

### 5.11 Extend the RMQ RPC controller in `nabu-gateway`

**Path:** `apps/nabu-gateway/src/openclaw/openclaw-rpc.controller.ts`

Add a new payload type and switch branch. The new branch pushes the
`config.patch` (deep-merge, preserves siblings) and triggers an immediate
refresh RPC so the plugin picks up the new `ops_` without waiting for its
6h interval.

```ts
interface OnePasswordPluginSetTokenPayload {
  method: 'one-password-plugin.set-token';
  organizationId: number;
  params: { apiToken: string };
}

type RpcPayload = EmailPluginSetTokenPayload | OnePasswordPluginSetTokenPayload;

// inside handle(payload) switch:

case 'one-password-plugin.set-token': {
  const { organizationId, params } = payload;
  const connection = await this.openclawService.getConnectionForOrg(organizationId);
  const current = await connection.rpc<{ hash: string }>('config.get');
  await connection.rpc('config.patch', {
    raw: JSON.stringify({
      plugins: {
        entries: {
          'nabu-1password': {
            enabled: params.apiToken !== '',
            config: { apiToken: params.apiToken, apiBaseUrl: 'http://app:6001' },
          },
        },
      },
    }),
    baseHash: current.hash,
  });
  // Best-effort: ask the plugin to fetch the new ops_ immediately.
  // Safe to fail — the periodic 6h refresh will pick it up regardless.
  try {
    await connection.rpc('nabu.onepassword.refresh', {});
  } catch (err) {
    this.logger.warn(
      `nabu.onepassword.refresh failed for org ${organizationId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { ok: true };
}
```

### 5.12 Dependency

**Path:** `package.json`

Add the pinned-exact 1Password SDK:

```json
{
  "dependencies": {
    "@1password/sdk": "0.4.0"
  }
}
```

The v0.x API is unstable per [1Password's own
docs](https://developer.1password.com/docs/sdks/) — pin exact, not with `^`.

### 5.13 Log scrubber

Add a global redactor to the existing NestJS logger setup (Winston or Pino
— find it near `AppLoggerModule` or the `main.ts` bootstrap):

```ts
const OPS_TOKEN_PATTERN = /ops_[A-Za-z0-9_\-]{20,}/g;

export function redactOpsTokens(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(OPS_TOKEN_PATTERN, "[REDACTED_OP_TOKEN]");
  }
  if (Array.isArray(obj)) return obj.map(redactOpsTokens);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, redactOpsTokens(v)]),
    );
  }
  return obj;
}
```

Wire this into the logger as a formatter / transform before output. It
catches accidental `ops_` leaks in exception messages, stack traces, or
ad-hoc `console.log` calls. The `ops_` prefix is a documented 1Password
sentinel, so the regex is safe (no risk of redacting unrelated strings).

## 6. Frontend page (sketch)

Page route: `/settings/integrations/1password`.

Endpoints it calls:

| Action              | Call                                         |
| ------------------- | -------------------------------------------- |
| Load current state  | `GET  /api/v1/onepassword/config`            |
| Save / onboard      | `POST /api/v1/onepassword/config`            |
| Test                | `POST /api/v1/onepassword/config/test`       |
| Rotate skill bearer | `POST /api/v1/onepassword/config/rotate-key` |
| Disconnect          | `DELETE /api/v1/onepassword/config`          |

Form fields:

- **Service Account Token** (masked, required): regex `^ops_[A-Za-z0-9_\-]+$`.
- **Default Vault** (optional): UUID or name. If present, `verifyToken()`
  asserts it's in the accessible vault list.

Display fields (after save):

- **Token fingerprint** (`sha256(ops_).slice(0,12)`) — for audit.
- **Last validated at**.
- **Accessible vaults** (names only, returned by the `test` endpoint).
- **Status** — healthy / stale / failed (error message).

Onboarding help block:

> 1. Create a 1Password Service Account in your 1Password web console
>    ([docs](https://developer.1password.com/docs/service-accounts/get-started/)).
> 2. Grant it access to the vaults your agent should read. **Vault access
>    is fixed at creation** — to add a vault later, you must issue a new token.
> 3. Paste the `ops_...` token below. It is encrypted at rest and never
>    exposed to other organizations.

One-time key reveal: after `POST /config` or `/rotate-key`, the response
`{ apiKey }` is shown **once** in a modal (for the user's records). It's
not persisted in the browser, not re-retrievable.

## 7. Acceptance — what to verify end-to-end

Run these in order. Each has a clear pass/fail.

1. **Migration applies.** `pnpm typeorm migration:run` (or equivalent) —
   `app_organization_one_password_configs` table exists.
2. **Encryption round-trips.** Unit test `OnePasswordEncryptionService` —
   `decrypt(encrypt(x)) === x`, and ciphertext is not equal to plaintext.
3. **Token validation.** Integration test: `POST /api/v1/onepassword/config`
   with a valid `ops_...` test token returns 201 `{ apiKey }`. With an
   invalid token returns 422.
4. **Two-factor skill callback.** Integration test: `POST /api/v1/onepassword/token`
   - with matching `{x-skill-token, x-organization-id}` → 200 `{ token: "ops_..." }`.
   - with mismatched org id → 401.
   - with missing headers → 401.
5. **Config patch reaches gateway.** After `POST /config`, exec into the
   tenant's OpenClaw container:
   ```
   docker compose exec openclaw-gateway \
     cat /home/node/.openclaw/openclaw.json | \
     jq '.plugins.entries["nabu-1password"]'
   ```
   Expect: `enabled: true`, non-empty `apiToken`.
6. **Plugin fetches ops\_ into env.** Check gateway logs:
   ```
   docker compose logs openclaw-gateway | grep 'nabu-1password'
   ```
   Expect: `[nabu-1password] token refreshed (fingerprint=<12 hex>)`. No
   occurrence of any `ops_` prefix anywhere in logs.
7. **`op` works inside container.**
   ```
   docker compose exec openclaw-gateway op whoami
   docker compose exec openclaw-gateway op vault list
   ```
   Both return valid results.
8. **Agent round-trip.** Send a message to the tenant's agent:
   _"Use the nabu-1password skill to `op read op://<TestVault>/<TestItem>/password`"_.
   Agent returns the secret. Does NOT attempt `op signin` or tmux.
9. **Rotation.** `POST /config/rotate-key`. Gateway logs show a new
   `token refreshed` line within seconds. `op whoami` still works.
10. **Delete.** `DELETE /config`. Gateway config shows `nabu-1password.enabled: false`.
    `op` calls fail with auth error. `process.env.OP_SERVICE_ACCOUNT_TOKEN`
    is cleared after next `gateway_start` / plugin deactivation.

## 8. Security posture

The raw `ops_` token exists in three places. Each is gated appropriately:

| Location                                                       | Protection                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| NestJS DB `service_account_token_encryption`                   | AES-256-GCM (scrypt-derived key from `APP_SECRET`, salt `nabu-op-v1`). Different salt from SMTP — no cross-integration decrypt risk. |
| NestJS process memory during `/token` callback                 | Transient; dropped as soon as response serialized. GC-deferred in V8 heap (JS constraint, accepted).                                 |
| Tenant OpenClaw gateway `process.env.OP_SERVICE_ACCOUNT_TOKEN` | Memory-only; never `openclaw.json`; never `.env` file; cleared on plugin `deactivate` / `gateway_stop`.                              |

Two-factor skill auth:

- `x-skill-token` (opaque per-org bearer) **alone** cannot fetch a token.
- `x-organization-id` (from docker-compose env, deliberately absent from
  `openclaw.json`) is required as a second factor.
- Prompt-extracting `openclaw.json` yields `apiToken` — useless without
  also knowing the org id AND having Docker-bridge-network access.

Scope isolation:

- 1Password service-account tokens are JWTs cryptographically bound to a
  single 1P account's SRP keyset. Tenant A's token **cannot** decrypt
  anything in tenant B's account — mathematical, not policy.
- Vault access is **immutable** after service-account creation. A
  compromised token's blast radius is exactly the vaults the tenant
  granted at creation time. Rotation alone does not re-scope.

Log scrubbing:

- `/ops_[A-Za-z0-9_\-]{20,}/g` → `[REDACTED_OP_TOKEN]` across all log
  transports. The `ops_` prefix is a documented sentinel ([1Password
  security docs](https://developer.1password.com/docs/service-accounts/security/)),
  so scanning is safe.

## 9. What's already done on the OpenClaw side (for your reference)

Nothing below requires changes from you. Listed so you know the contract
you're building against.

- **Plugin:** [extensions/nabu-1password/](../../extensions/nabu-1password/)
  - [openclaw.plugin.json](../../extensions/nabu-1password/openclaw.plugin.json) — manifest.
  - [index.ts](../../extensions/nabu-1password/index.ts) — fetches token at `gateway_start`, periodic refresh, `nabu.onepassword.refresh` RPC, env hygiene.
  - [skills/nabu-1password/SKILL.md](../../extensions/nabu-1password/skills/nabu-1password/SKILL.md) — replacement skill instructing agents to use `op` directly, no tmux.
- **`op` CLI in base image:** [Dockerfile](../../Dockerfile) now installs `1password-cli` 2.34.0 via signed apt repo with GPG-fingerprint verification. Every Nabu tenant's gateway container inherits it.
- **Spawn-seed config:** [nabu-integration/spawn-seed/.openclaw/openclaw.json](../spawn-seed/.openclaw/openclaw.json) declares `nabu-1password` in `plugins.allow`, includes a default entry with `enabled: false` (flipped to `true` by your `config.patch`), and disables the bundled desktop-oriented `1password` skill via `skills.entries."1password".enabled: false`.

## 10. References

**1Password:**

- [Service accounts overview](https://developer.1password.com/docs/service-accounts/)
- [Service accounts + CLI](https://developer.1password.com/docs/service-accounts/use-with-1password-cli/)
- [Security model](https://developer.1password.com/docs/service-accounts/security/)
- [Rate limits](https://developer.1password.com/docs/service-accounts/rate-limits/)
- [JS SDK](https://github.com/1Password/onepassword-sdk-js) (pinned to `0.4.0`)

**OpenClaw (our fork):**

- [Plugin SDK entry](../../src/plugin-sdk/plugin-entry.ts)
- [`nabu-email` reference pattern](../../extensions/nabu-email/) — this integration's direct template.
- [`config.patch` deep-merge handler](../../src/gateway/server-methods/config.ts#L509-L511)
- [Exec inherits `process.env`](../../src/process/exec.ts#L219)
- [Host-env allowlist (why we use process.env, not per-call overrides)](../../src/infra/host-env-security.ts#L19-L28)
- [Skill precedence (why we named the skill `nabu-1password`)](../../src/agents/skills/workspace.ts#L454)

**Research that led here:**

- [Pass 1 brief](../research/1password-enablement.md)
- [Pass 2 brief](../research/1password-enablement-pass2.md)
