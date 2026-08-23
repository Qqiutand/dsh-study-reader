/** Typed assets owned by the Study injection studio. */
export type AssetNamespace = 'library' | 'prompt' | 'skill' | 'profile'
export type StudioAssetKind = 'source' | 'prompt' | 'skill' | 'profile' | 'tool' | 'provider-connection'
export type PromptLayer = 'system-addon'
export type SkillInvocation = 'user' | 'model' | 'both'

export interface AssetFolderRecord {
  readonly id: string
  readonly namespace: AssetNamespace
  readonly parentId?: string
  readonly name: string
  readonly sortKey: string
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastCommandId?: string
}

export interface AssetFolderView extends AssetFolderRecord {
  readonly origin: 'managed' | 'registry'
  readonly capabilities: {
    readonly canCreateChild: boolean
    readonly canRename: boolean
    readonly canMove: boolean
    readonly canDelete: boolean
    readonly canAcceptAssets: boolean
  }
}

export interface StudioAssetSummary {
  readonly id: string
  readonly kind: StudioAssetKind
  readonly namespace?: AssetNamespace
  readonly folderId?: string
  readonly name: string
  readonly description?: string
  readonly recordVersion: number
  readonly archived?: boolean
  readonly badges: readonly string[]
  /** Present only for library assets so paged rows never depend on a separate capped source projection. */
  readonly source?: import('../study/types.ts').SourceSummary
}

export interface TreeChildrenResult {
  readonly folders: readonly AssetFolderView[]
  readonly assets: readonly StudioAssetSummary[]
  readonly nextCursor?: string
  readonly total: number
}

export interface ListTreeChildrenRequest {
  readonly sessionId: string
  readonly namespace: AssetNamespace
  readonly parentId?: string
  readonly cursor?: string
  readonly limit?: number
}

export interface ListStudioAssetsRequest {
  readonly sessionId: string
  readonly namespace: AssetNamespace
  readonly folderId?: string
  readonly query?: string
  /** Omitted preserves the complete administrative projection. */
  readonly archived?: 'active' | 'archived' | 'all'
  readonly cursor?: string
  readonly limit?: number
}

export interface StudioAssetListResult {
  readonly assets: readonly StudioAssetSummary[]
  readonly nextCursor?: string
  readonly total: number
}

export interface GetStudioAssetDetailRequest {
  readonly sessionId: string
  readonly kind: Extract<StudioAssetKind, 'source' | 'prompt' | 'skill' | 'profile'>
  readonly assetId: string
}

export type StudioAssetDetail =
  | { readonly kind: 'source'; readonly summary: StudioAssetSummary; readonly value: import('../study/types.ts').SourceSummary }
  | { readonly kind: 'prompt'; readonly summary: StudioAssetSummary; readonly value: PromptAssetRecord }
  | { readonly kind: 'skill'; readonly summary: StudioAssetSummary; readonly value: import('../study/management.ts').StudySkill }
  | { readonly kind: 'profile'; readonly summary: StudioAssetSummary; readonly value: InjectionProfileRecord }

export interface ProviderConnectionRecord {
  readonly schemaVersion: 1
  readonly id: string
  readonly providerId: string
  readonly providerKind: string
  readonly displayName: string
  readonly builtin?: boolean
  readonly active?: boolean
  readonly credentialRef: string
  readonly endpoint: string
  readonly enabled: boolean
  readonly model?: string
  readonly nonSecretConfig: Readonly<Record<string, string | number | boolean>>
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastCommandId?: string
}

export interface SaveProviderConnectionRequest {
  readonly sessionId: string
  readonly commandId: string
  readonly providerId: string
  readonly connectionId?: string
  readonly displayName: string
  readonly expectedVersion: number
  readonly endpoint: string
  readonly enabled: boolean
  readonly model?: string
  readonly nonSecretConfig: Readonly<Record<string, string | number | boolean>>
  readonly activate: boolean
}

export interface DeleteProviderConnectionRequest {
  readonly sessionId: string
  readonly commandId: string
  readonly connectionId: string
  readonly expectedVersion: number
}

export interface ProviderConnectionTestResult {
  readonly ok: boolean
  readonly latencyMs: number
  readonly providerStatus: 'available' | 'degraded' | 'unavailable' | 'misconfigured'
  readonly errorCode?: string
  readonly message: string
}

export interface ProviderConnectionCommandReceipt {
  readonly schemaVersion: 1
  readonly commandId: string
  readonly providerId: string
  readonly canonicalPayload: string
  readonly payloadHash: string
  readonly state: 'pending' | 'committed' | 'rejected'
  readonly result?: ProviderConnectionRecord
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export type AssetTreeCommand =
  | { readonly kind: 'create-folder'; readonly namespace: AssetNamespace; readonly name: string; readonly parentId?: string }
  | { readonly kind: 'rename-folder'; readonly folderId: string; readonly name: string; readonly expectedVersion: number }
  | { readonly kind: 'move-folder'; readonly folderId: string; readonly parentId?: string; readonly expectedVersion: number }
  | { readonly kind: 'delete-folder'; readonly folderId: string; readonly expectedVersion: number }
  | { readonly kind: 'move-asset'; readonly namespace: AssetNamespace; readonly assetId: string; readonly folderId?: string; readonly expectedVersion: number }

export interface PromptRevision {
  readonly version: number
  readonly layer: PromptLayer
  readonly priority: number
  readonly content: string
  readonly contentHash: string
  readonly estimatedTokens: number
  readonly createdAt: number
}

export interface PromptAssetRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly folderId?: string
  readonly source: 'builtin' | 'user'
  readonly readonly: boolean
  readonly currentVersion: number
  readonly recordVersion: number
  readonly archived: boolean
  readonly revisions: readonly PromptRevision[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PromptBinding {
  readonly promptId: string
  readonly promptVersion: number
  readonly enabled: boolean
  readonly order: number
}

export interface ProfileSkillBinding {
  readonly skillId: string
  readonly skillVersion: number
  readonly enabled: boolean
  readonly invocation: SkillInvocation
}

export interface ToolPolicyBinding {
  readonly toolName: string
  readonly enabled: boolean
  readonly guidanceAppendix?: string
}

export interface InjectionProfileRevision {
  readonly version: number
  readonly promptBindings: readonly PromptBinding[]
  readonly skillBindings: readonly ProfileSkillBinding[]
  readonly toolPolicies: readonly ToolPolicyBinding[]
  readonly modelPolicy:
    | { readonly kind: 'inherit-session' }
    | { readonly kind: 'fixed-provider'; readonly providerId: string; readonly modelId: string }
  readonly createdAt: number
}

export interface InjectionProfileRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly folderId?: string
  readonly currentVersion: number
  readonly recordVersion: number
  readonly archived: boolean
  readonly revisions: readonly InjectionProfileRevision[]
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SessionInjectionBinding {
  readonly sessionId: string
  readonly profileId: string
  readonly profileVersion: number
  readonly recordVersion: number
  readonly appliedAt: number
  readonly lastCommandId?: string
}

export interface InjectionSkillDescriptor {
  readonly id: string
  /** Distinguishes always-available Reader methods from Profile-managed copies. */
  readonly origin: 'builtin' | 'managed'
  readonly version: number
  readonly name: string
  readonly description: string
  readonly trigger: string
  readonly requiredTools: readonly string[]
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
}

export interface InjectionToolDescriptor {
  readonly name: string
  readonly specVersion: number
  readonly schemaHash: string
  readonly description: string
}

export interface InjectionManifest {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly profile: { readonly id: string; readonly version: number }
  readonly promptFragments: readonly {
    readonly id: string
    readonly version: number
    readonly layer: PromptLayer | 'immutable-system'
    readonly hash: string
  }[]
  readonly skills: readonly {
    readonly id: string
    readonly version: number
    readonly invocation: SkillInvocation
  }[]
  readonly tools: readonly {
    readonly name: string
    readonly specVersion: number
    readonly schemaHash: string
    readonly enabled: true
  }[]
  readonly estimatedTokens: number
  readonly promptHash: string
  readonly toolSetHash: string
  readonly compiledAt: number
}

export interface InjectionDiagnostic {
  readonly severity: 'info' | 'warning' | 'error'
  readonly code: string
  readonly message: string
  readonly assetId?: string
}

export interface CompiledInjection {
  readonly systemText: string
  readonly skillCatalogText: string
  readonly toolGuidanceText: string
  readonly manifest: InjectionManifest
  readonly diagnostics: readonly InjectionDiagnostic[]
}

/** Host-owned mutation vocabulary for versioned injection assets. */
export type InjectionStudioCommand =
  | {
      readonly kind: 'create-prompt'
      readonly name: string
      readonly description: string
      readonly folderId?: string
      readonly layer: PromptLayer
      readonly priority: number
      readonly content: string
    }
  | {
      readonly kind: 'revise-prompt'
      readonly promptId: string
      readonly expectedRecordVersion: number
      readonly name: string
      readonly description: string
      readonly layer: PromptLayer
      readonly priority: number
      readonly content: string
    }
  | {
      readonly kind: 'archive-prompt'
      readonly promptId: string
      readonly expectedRecordVersion: number
      readonly archived: boolean
    }
  | {
      readonly kind: 'delete-prompt'
      readonly promptId: string
      readonly expectedRecordVersion: number
    }
  | {
      readonly kind: 'create-profile'
      readonly name: string
      readonly description: string
      readonly folderId?: string
      readonly promptBindings: readonly PromptBinding[]
      readonly skillBindings: readonly ProfileSkillBinding[]
      readonly toolPolicies: readonly ToolPolicyBinding[]
      readonly modelPolicy: InjectionProfileRevision['modelPolicy']
    }
  | {
      readonly kind: 'revise-profile'
      readonly profileId: string
      readonly expectedRecordVersion: number
      readonly name: string
      readonly description: string
      readonly promptBindings: readonly PromptBinding[]
      readonly skillBindings: readonly ProfileSkillBinding[]
      readonly toolPolicies: readonly ToolPolicyBinding[]
      readonly modelPolicy: InjectionProfileRevision['modelPolicy']
    }
  | {
      readonly kind: 'archive-profile'
      readonly profileId: string
      readonly expectedRecordVersion: number
      readonly archived: boolean
    }
  | {
      readonly kind: 'delete-profile'
      readonly profileId: string
      readonly expectedRecordVersion: number
    }
  | {
      readonly kind: 'activate-profile'
      readonly profileId: string
      readonly profileVersion: number
      readonly expectedBindingVersion: number
    }
  | {
      readonly kind: 'deactivate-profile'
      readonly expectedBindingVersion: number
    }
  | {
      readonly kind: 'apply-asset-tree'
      readonly treeCommand: AssetTreeCommand
    }

export interface ExecuteInjectionStudioCommandRequest {
  readonly sessionId: string
  readonly commandId: string
  readonly command: InjectionStudioCommand
}

export interface ExecuteInjectionStudioCommandResult {
  readonly accepted: true
  readonly prompt?: PromptAssetRecord
  readonly promptDeleted?: true
  readonly profile?: InjectionProfileRecord
  readonly profileDeleted?: true
  readonly binding?: SessionInjectionBinding
  readonly bindingCleared?: true
  readonly folder?: AssetFolderRecord
}

/** Full Host repository state. Never return this shape through a browser Remote. */
export interface InjectionStudioRepositorySnapshot {
  readonly immutableBaseline: PromptAssetRecord
  readonly prompts: readonly PromptAssetRecord[]
  readonly profiles: readonly InjectionProfileRecord[]
  readonly skills: readonly InjectionSkillDescriptor[]
  readonly folders: readonly AssetFolderRecord[]
  readonly binding?: SessionInjectionBinding
}

export interface InjectionPromptChoice {
  readonly id: string
  readonly name: string
  readonly folderId?: string
  readonly currentVersion: number
  readonly recordVersion: number
  readonly archived: boolean
  readonly readonly: boolean
}

export interface InjectionProfileChoice {
  readonly id: string
  readonly name: string
  readonly folderId?: string
  readonly currentVersion: number
  readonly recordVersion: number
  readonly archived: boolean
}

/** Browser index: compact choices and binding only; revision bodies are fetched by getAssetDetail. */
export interface InjectionStudioSnapshot {
  readonly immutableBaseline: PromptAssetRecord
  readonly prompts: readonly InjectionPromptChoice[]
  readonly profiles: readonly InjectionProfileChoice[]
  readonly skills: readonly InjectionSkillDescriptor[]
  readonly folders: readonly AssetFolderRecord[]
  readonly binding?: SessionInjectionBinding
}

export interface CompileInjectionPreviewRequest {
  readonly sessionId: string
  readonly profileId?: string
  readonly profileVersion?: number
}

/** Durable idempotency envelope for one Studio mutation. */
export interface InjectionStudioCommandReceipt {
  readonly schemaVersion: 1
  readonly commandId: string
  readonly sessionId: string
  readonly kind: InjectionStudioCommand['kind']
  readonly command: InjectionStudioCommand
  readonly canonicalPayload: string
  readonly payloadHash: string
  readonly state: 'pending' | 'committed' | 'rejected'
  readonly result?: ExecuteInjectionStudioCommandResult
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly createdAt: number
  readonly updatedAt: number
}
