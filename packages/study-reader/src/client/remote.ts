/** Browser contract containing only methods used by the library and management surfaces. */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  GetSessionSourceSelectionRequest, ImportStatusRequest, ImportStatusView,
  ListImportStatusesRequest, ListSourcesRequest,
  PrepareUploadRequest, PrepareUploadResult, ReadRequest, ReadResult, RenewUploadRequest,
  SearchDocumentRequest, SearchDocumentResult, SessionSourceSelectionView,
  SetSessionSourceSelectionRequest, SetSourceAccessRequest, SetSourceAccessResult,
  OpenSourceForSessionRequest, OpenSourceForSessionResult, LibrarySnapshot,
  GetSourcePreviewRequest, SourcePreview,
  SourceSummary, StudyBootstrapView, ToolDescriptorView,
  ProviderConnectionView,
  WorkspaceDefaultView, SaveWorkspaceDefaultRequest, ClearWorkspaceDefaultRequest,
  CreateExternalAccessRequest, CreateExternalAccessResult, ExternalAccessSnapshot,
  DeleteExternalReadingSetRequest, ExternalAccessView, RevokeExternalAccessRequest, SaveExternalReadingSetRequest,
} from '../study/types.ts'
import type {
  AgentGrant, ManagementFolder, ManagementFolderView, ManagementProposal,
  ManagementSkillView, RegistrySkillCatalogStatus, StudySkill,
} from '../study/management.ts'
import type {
  CompileInjectionPreviewRequest, CompiledInjection,
  ExecuteInjectionStudioCommandRequest, ExecuteInjectionStudioCommandResult,
  InjectionStudioSnapshot,
  GetStudioAssetDetailRequest, ListStudioAssetsRequest, ListTreeChildrenRequest,
  ProviderConnectionRecord,
  ProviderConnectionTestResult,
  SaveProviderConnectionRequest,
  DeleteProviderConnectionRequest,
  StudioAssetDetail, StudioAssetListResult, TreeChildrenResult,
} from '../studio/types.ts'

type Call<T> = Promise<RemoteResult<T>>

export interface StudyRemote {
  bootstrap(): Call<StudyBootstrapView>
  getLibrarySnapshot(request: { readonly sessionId: string }): Call<LibrarySnapshot>
  getSourcePreview(request: GetSourcePreviewRequest): Call<SourcePreview>
  managementSnapshot(request: { readonly sessionId: string }): Call<{ readonly controlMode: 'trusted-local-user' | 'disabled'; readonly folders: readonly ManagementFolderView[]; readonly grants: readonly AgentGrant[]; readonly grantVersion: number; readonly skills: readonly ManagementSkillView[]; readonly proposals: readonly ManagementProposal[]; readonly sources: readonly (SourceSummary & { readonly folderId?: string; readonly locationVersion: number })[]; readonly registrySkills: RegistrySkillCatalogStatus }>
  listToolCatalog(request: { readonly sessionId: string }): Call<readonly ToolDescriptorView[]>
  providerConnectionStatus(request: { readonly sessionId: string }): Call<ProviderConnectionView>
  listProviderConnections(request: { readonly sessionId: string }): Call<readonly ProviderConnectionView[]>
  saveProviderConnection(request: SaveProviderConnectionRequest): Call<ProviderConnectionRecord>
  deleteProviderConnection(request: DeleteProviderConnectionRequest): Call<{ readonly deleted: true }>
  testProviderConnection(request: { readonly sessionId: string; readonly providerId: string }): Call<ProviderConnectionTestResult>
  studioSnapshot(request: { readonly sessionId: string }): Call<InjectionStudioSnapshot>
  getWorkspaceDefault(request: { readonly sessionId: string }): Call<WorkspaceDefaultView>
  saveWorkspaceDefault(request: SaveWorkspaceDefaultRequest): Call<WorkspaceDefaultView>
  clearWorkspaceDefault(request: ClearWorkspaceDefaultRequest): Call<WorkspaceDefaultView>
  externalAccessSnapshot(request: { readonly sessionId: string }): Call<ExternalAccessSnapshot>
  createExternalAccess(request: CreateExternalAccessRequest): Call<CreateExternalAccessResult>
  saveExternalReadingSet(request: SaveExternalReadingSetRequest): Call<ExternalAccessView>
  deleteExternalReadingSet(request: DeleteExternalReadingSetRequest): Call<ExternalAccessView>
  revokeExternalAccess(request: RevokeExternalAccessRequest): Call<ExternalAccessView>
  executeStudioCommand(request: ExecuteInjectionStudioCommandRequest): Call<ExecuteInjectionStudioCommandResult>
  compileInjectionProfile(request: CompileInjectionPreviewRequest): Call<CompiledInjection>
  listTreeChildren(request: ListTreeChildrenRequest): Call<TreeChildrenResult>
  listAssets(request: ListStudioAssetsRequest): Call<StudioAssetListResult>
  getAssetDetail(request: GetStudioAssetDetailRequest): Call<StudioAssetDetail>
  executeManagementCommand(request: { readonly sessionId: string; readonly commandId: string; readonly command: unknown }): Call<{ readonly accepted: true; readonly folder?: ManagementFolder; readonly proposal?: ManagementProposal; readonly grants?: readonly AgentGrant[]; readonly grantVersion?: number }>
  renameSource(request: { readonly sessionId: string; readonly commandId: string; readonly sourceId: string; readonly title: string; readonly expectedVersion: number }): Call<{ readonly accepted: true; readonly sourceId: string; readonly title: string; readonly recordVersion: number }>
  moveSource(request: { readonly sessionId: string; readonly commandId: string; readonly sourceId: string; readonly folderId?: string; readonly expectedVersion: number }): Call<{ readonly sourceId: string; readonly folderId?: string; readonly version: number; readonly updatedAt: number }>
  executeSkillCommand(request: { readonly sessionId: string; readonly commandId: string; readonly command: unknown }): Call<{ readonly accepted: true; readonly skill?: StudySkill; readonly deletedSkillId?: string }>
  getManagementSkill(request: { readonly sessionId: string; readonly skillId: string }): Call<StudySkill>
  decideManagementProposal(request: { readonly sessionId: string; readonly commandId: string; readonly proposalId: string; readonly expectedVersion: number; readonly decision: 'approved' | 'rejected'; readonly expectedTitle?: string }): Call<ManagementProposal>
  prepareUpload(request: PrepareUploadRequest): Call<PrepareUploadResult>
  renewUpload(request: RenewUploadRequest): Call<PrepareUploadResult>
  importStatus(request: ImportStatusRequest): Call<ImportStatusView>
  listImportStatuses(request: ListImportStatusesRequest): Call<readonly ImportStatusView[]>
  listSources(request: ListSourcesRequest): Call<readonly SourceSummary[]>
  setSourceAccess(request: SetSourceAccessRequest): Call<SetSourceAccessResult>
  openSourceForSession(request: OpenSourceForSessionRequest): Call<OpenSourceForSessionResult>
  read(request: ReadRequest): Call<ReadResult>
  search(request: SearchDocumentRequest): Call<SearchDocumentResult>
  getSessionSourceSelection(request: GetSessionSourceSelectionRequest): Call<SessionSourceSelectionView>
  setSessionSourceSelection(request: SetSessionSourceSelectionRequest): Call<SessionSourceSelectionView>
}
