# Immich 3.3.5 API operation inventory

- Official source tag: `v3.3.5`
- Commit: `8303cb117e197c700332b33b61b45314c9cc5bb4`
- OpenAPI SHA-256: `632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9`
- Scope: **279 operations / 193 paths / 41 primary tags**.
- `Deprecated` is an additional tag on 24 operations; it is not a separate primary group.
- Permission values below describe upstream behavior; they are not an MCP-side allowlist.
- `all (default)` means the controller omits an explicit permission and upstream AuthService defaults to `all`. It does not mean no authentication.
- `no key-permission check` means upstream explicitly sets `permission: false`. Other authentication and resource checks still apply.
- OpenAPI security alternatives do not prove a session-only operation works with an API key. See runtime-context notes and the auth review.

## Counts by primary tag

| Primary tag | Count |
| --- | ---: |
| API keys | 7 |
| Activities | 4 |
| Albums | 13 |
| Asset files | 4 |
| Assets | 26 |
| Authentication | 17 |
| Authentication (admin) | 1 |
| Cluster groups | 8 |
| Config (admin) | 3 |
| Config (public) | 2 |
| Config (user) | 2 |
| Database Backups (admin) | 5 |
| Download | 2 |
| Duplicates | 4 |
| Faces | 4 |
| Jobs | 3 |
| Libraries | 8 |
| Maintenance (admin) | 9 |
| Map | 2 |
| Memories | 8 |
| Notifications | 6 |
| Notifications (admin) | 3 |
| Partners | 5 |
| People | 15 |
| Plugins | 4 |
| Queues | 5 |
| Search | 10 |
| Server | 14 |
| Sessions | 6 |
| Shared links | 9 |
| Stacks | 7 |
| Sync | 4 |
| System config | 4 |
| System metadata | 4 |
| Tags | 9 |
| Timeline | 2 |
| Trash | 3 |
| Users | 16 |
| Users (admin) | 11 |
| Views | 2 |
| Workflows | 8 |

## Operations

### API keys

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getApiKeys` | GET | `/api-keys` | `apiKey.read` |  | Stable | json |
| `createApiKey` | POST | `/api-keys` | `apiKey.create` |  | Stable | json |
| `getMyApiKey` | GET | `/api-keys/me` | `no key-permission check` |  | Stable | json |
| `deleteApiKey` | DELETE | `/api-keys/{id}` | `apiKey.delete` |  | Stable | no_content_schema |
| `getApiKey` | GET | `/api-keys/{id}` | `apiKey.read` |  | Stable | json |
| `updateApiKey` | PUT | `/api-keys/{id}` | `apiKey.update` |  | Deprecated | json |
| `rotateApiKey` | POST | `/api-keys/{id}/rotate` | `apiKey.rotate` |  | not specified | json |

### Activities

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getActivities` | GET | `/activities` | `activity.read` |  | Stable | json |
| `createActivity` | POST | `/activities` | `activity.create` |  | Stable | json |
| `getActivityStatistics` | GET | `/activities/statistics` | `activity.statistics` |  | Stable | json |
| `deleteActivity` | DELETE | `/activities/{id}` | `activity.delete` |  | Stable | no_content_schema |

### Albums

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAllAlbums` | GET | `/albums` | `album.read` |  | Stable | json |
| `createAlbum` | POST | `/albums` | `album.create` |  | Stable | json |
| `addAssetsToAlbums` | PUT | `/albums/assets` | `albumAsset.create` |  | Stable | json |
| `getAlbumStatistics` | GET | `/albums/statistics` | `album.statistics` |  | Stable | json |
| `deleteAlbum` | DELETE | `/albums/{id}` | `album.delete` |  | Stable | no_content_schema |
| `getAlbumInfo` | GET | `/albums/{id}` | `album.read` |  | Stable | json |
| `updateAlbumInfo` | PATCH | `/albums/{id}` | `album.update` |  | Stable | json |
| `removeAssetFromAlbum` | DELETE | `/albums/{id}/assets` | `albumAsset.delete` |  | Stable | json |
| `addAssetsToAlbum` | PUT | `/albums/{id}/assets` | `albumAsset.create` |  | Stable | json |
| `getAlbumMapMarkers` | GET | `/albums/{id}/map-markers` | `album.read` |  | not specified | json |
| `removeUserFromAlbum` | DELETE | `/albums/{id}/user/{userId}` | `albumUser.delete` |  | Stable | no_content_schema |
| `updateAlbumUser` | PUT | `/albums/{id}/user/{userId}` | `albumUser.update` |  | Stable | no_content_schema |
| `addUsersToAlbum` | PUT | `/albums/{id}/users` | `albumUser.create` |  | Stable | json |

### Asset files

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `searchAssetFiles` | GET | `/asset-files` | `assetFile.read` |  | Alpha | json |
| `deleteAssetFile` | DELETE | `/asset-files/{id}` | `assetFile.delete` |  | Alpha | no_content_schema |
| `getAssetFile` | GET | `/asset-files/{id}` | `assetFile.read` |  | Alpha | json |
| `downloadAssetFile` | GET | `/asset-files/{id}/download` | `assetFile.download` |  | Alpha | binary |

### Assets

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `deleteAssets` | DELETE | `/assets` | `asset.delete` |  | Stable | no_content_schema |
| `uploadAsset` | POST | `/assets` | `asset.upload` |  | Stable | json |
| `updateAssets` | PUT | `/assets` | `asset.update` |  | Deprecated | no_content_schema |
| `checkBulkUpload` | POST | `/assets/bulk-upload-check` | `asset.upload` |  | Stable | json |
| `copyAsset` | PUT | `/assets/copy` | `asset.copy` |  | Stable | no_content_schema |
| `runAssetJobs` | POST | `/assets/jobs` | `job.create` |  | Stable | no_content_schema |
| `deleteBulkAssetMetadata` | DELETE | `/assets/metadata` | `asset.update` |  | Beta | no_content_schema |
| `updateBulkAssetMetadata` | PUT | `/assets/metadata` | `asset.update` |  | Beta | json |
| `getAssetStatistics` | GET | `/assets/statistics` | `asset.statistics` |  | Stable | json |
| `getAssetInfo` | GET | `/assets/{id}` | `asset.read` |  | Stable | json |
| `updateAsset` | PUT | `/assets/{id}` | `asset.update` |  | Deprecated | json |
| `removeAssetEdits` | DELETE | `/assets/{id}/edits` | `asset.edit.delete` |  | Beta | no_content_schema |
| `getAssetEdits` | GET | `/assets/{id}/edits` | `asset.edit.get` |  | Beta | json |
| `editAsset` | PUT | `/assets/{id}/edits` | `asset.edit.create` |  | Beta | json |
| `getAssetMetadata` | GET | `/assets/{id}/metadata` | `asset.read` |  | Stable | json |
| `updateAssetMetadata` | PUT | `/assets/{id}/metadata` | `asset.update` |  | Stable | json |
| `deleteAssetMetadata` | DELETE | `/assets/{id}/metadata/{key}` | `asset.update` |  | Stable | no_content_schema |
| `getAssetMetadataByKey` | GET | `/assets/{id}/metadata/{key}` | `asset.read` |  | Stable | json |
| `getAssetOcr` | GET | `/assets/{id}/ocr` | `asset.read` |  | Stable | json |
| `downloadAsset` | GET | `/assets/{id}/original` | `asset.download` |  | Stable | binary |
| `viewAsset` | GET | `/assets/{id}/thumbnail` | `asset.view` |  | Stable | binary |
| `playAssetVideo` | GET | `/assets/{id}/video/playback` | `asset.view` |  | Stable | binary |
| `getMainPlaylist` | GET | `/assets/{id}/video/stream/main.m3u8` | `asset.view` |  | Alpha | hls_playlist |
| `endSession` | DELETE | `/assets/{id}/video/stream/{sessionId}` | `asset.view` |  | Alpha | no_content_schema |
| `getMediaPlaylist` | GET | `/assets/{id}/video/stream/{sessionId}/{variantIndex}/playlist.m3u8` | `asset.view` |  | Alpha | hls_playlist |
| `getSegment` | GET | `/assets/{id}/video/stream/{sessionId}/{variantIndex}/{filename}` | `asset.view` |  | Alpha | binary |

### Authentication

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `signUpAdmin` | POST | `/auth/admin-sign-up` | `public; setup only` |  | Stable | json |
| `changePassword` | POST | `/auth/change-password` | `auth.changePassword` |  | Stable | json |
| `login` | POST | `/auth/login` | `public` |  | Stable | json |
| `logout` | POST | `/auth/logout` | `all (default)` |  | Stable | json |
| `resetPinCode` | DELETE | `/auth/pin-code` | `pinCode.delete` |  | Stable | no_content_schema |
| `setupPinCode` | POST | `/auth/pin-code` | `pinCode.create` |  | Stable | no_content_schema |
| `changePinCode` | PUT | `/auth/pin-code` | `pinCode.update` |  | Stable | no_content_schema |
| `lockAuthSession` | POST | `/auth/session/lock` | `all (default)` |  | Stable | no_content_schema |
| `unlockAuthSession` | POST | `/auth/session/unlock` | `all (default)` |  | Stable | no_content_schema |
| `getAuthStatus` | GET | `/auth/status` | `all (default)` |  | Stable | json |
| `validateAccessToken` | POST | `/auth/validateToken` | `no key-permission check` |  | Stable | json |
| `startOAuth` | POST | `/oauth/authorize` | `public` |  | Stable | json |
| `logoutOAuth` | POST | `/oauth/backchannel-logout` | `public` |  | not specified | no_content_schema |
| `finishOAuth` | POST | `/oauth/callback` | `public` |  | Stable | json |
| `linkOAuthAccount` | POST | `/oauth/link` | `all (default)` |  | Stable | json |
| `redirectOAuthToMobile` | GET | `/oauth/mobile-redirect` | `public` |  | Stable | no_content_schema |
| `unlinkOAuthAccount` | POST | `/oauth/unlink` | `all (default)` |  | Stable | json |

### Authentication (admin)

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `unlinkAllOAuthAccountsAdmin` | POST | `/admin/auth/unlink-all` | `adminAuth.unlinkAll` | yes | Stable | no_content_schema |

### Cluster groups

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getClusterGroupRequests` | GET | `/cluster-groups/requests` | `clusterGroupRequest.read` |  | not specified | json |
| `deleteClusterGroupRequest` | DELETE | `/cluster-groups/requests/{id}` | `clusterGroupRequest.delete` |  | not specified | no_content_schema |
| `acceptClusterGroupRequest` | POST | `/cluster-groups/requests/{id}/accept` | `clusterGroupRequest.create` |  | not specified | no_content_schema |
| `leaveClusterGroup` | POST | `/cluster-groups/{id}/leave` | `clusterGroup.leave` |  | not specified | no_content_schema |
| `clusterGroupRegeneratePeople` | POST | `/cluster-groups/{id}/regenerate-people` | `clusterGroup.read` |  | not specified | no_content_schema |
| `getClusterGroupRequestsForGroup` | GET | `/cluster-groups/{id}/requests` | `clusterGroupRequest.read` |  | not specified | json |
| `createClusterGroupRequest` | PUT | `/cluster-groups/{id}/requests` | `clusterGroupRequest.create` |  | not specified | json |
| `getClusterGroupUsers` | GET | `/cluster-groups/{id}/users` | `clusterGroup.read` |  | not specified | json |

### Config (admin)

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAdminConfig` | GET | `/admin/config` | `adminConfig.read` | yes | Alpha | json |
| `updateAdminConfig` | PUT | `/admin/config` | `adminConfig.update` | yes | Alpha | json |
| `getAdminConfigDefaults` | GET | `/admin/config/defaults` | `adminConfig.read` | yes | Alpha | json |

### Config (public)

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getPublicConfig` | GET | `/public/config` | `public` |  | Alpha | json |
| `getPublicConfigDefaults` | GET | `/public/config/defaults` | `public` |  | Alpha | json |

### Config (user)

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getUserConfig` | GET | `/config` | `userConfig.read` |  | Alpha | json |
| `getUserConfigDefaults` | GET | `/config/defaults` | `userConfig.read` |  | Alpha | json |

### Database Backups (admin)

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `deleteDatabaseBackup` | DELETE | `/admin/database-backups` | `backup.delete` | yes | Alpha | no_content_schema |
| `listDatabaseBackups` | GET | `/admin/database-backups` | `maintenance` | yes | Alpha | json |
| `startDatabaseRestoreFlow` | POST | `/admin/database-backups/start-restore` | `public; setup only` |  | Alpha | no_content_schema |
| `uploadDatabaseBackup` | POST | `/admin/database-backups/upload` | `backup.upload` | yes | Alpha | no_content_schema |
| `downloadDatabaseBackup` | GET | `/admin/database-backups/{filename}` | `backup.download` | yes | Alpha | binary |

### Download

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `downloadArchive` | POST | `/download/archive` | `asset.download` |  | Stable | binary |
| `getDownloadInfo` | POST | `/download/info` | `asset.download` |  | Stable | json |

### Duplicates

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `deleteDuplicates` | DELETE | `/duplicates` | `duplicate.delete` |  | Stable | no_content_schema |
| `getAssetDuplicates` | GET | `/duplicates` | `duplicate.read` |  | Stable | json |
| `resolveDuplicates` | POST | `/duplicates/resolve` | `duplicate.delete` |  | Alpha | json |
| `deleteDuplicate` | DELETE | `/duplicates/{id}` | `duplicate.delete` |  | Stable | no_content_schema |

### Faces

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getFaces` | GET | `/faces` | `face.read` |  | Stable | json |
| `createFace` | POST | `/faces` | `face.create` |  | Stable | no_content_schema |
| `deleteFace` | DELETE | `/faces/{id}` | `face.delete` |  | Stable | no_content_schema |
| `reassignFacesById` | PUT | `/faces/{id}` | `face.update` |  | Stable | json |

### Jobs

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getQueuesLegacy` | GET | `/jobs` | `job.read` | yes | Deprecated | json |
| `createJob` | POST | `/jobs` | `job.create` | yes | Stable | no_content_schema |
| `runQueueCommandLegacy` | PUT | `/jobs/{name}` | `job.create` | yes | Deprecated | json |

### Libraries

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAllLibraries` | GET | `/libraries` | `library.read` | yes | Stable | json |
| `createLibrary` | POST | `/libraries` | `library.create` | yes | Stable | json |
| `deleteLibrary` | DELETE | `/libraries/{id}` | `library.delete` | yes | Stable | no_content_schema |
| `getLibrary` | GET | `/libraries/{id}` | `library.read` | yes | Stable | json |
| `updateLibrary` | PUT | `/libraries/{id}` | `library.update` | yes | Deprecated | json |
| `scanLibrary` | POST | `/libraries/{id}/scan` | `library.update` | yes | Stable | no_content_schema |
| `getLibraryStatistics` | GET | `/libraries/{id}/statistics` | `library.statistics` | yes | Stable | json |
| `validate` | POST | `/libraries/{id}/validate` | `all (default)` | yes | Stable | json |

### Maintenance (admin)

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getIntegrityReport` | GET | `/admin/integrity/report` | `maintenance` | yes | Alpha | json |
| `deleteIntegrityReport` | DELETE | `/admin/integrity/report/{id}` | `maintenance` | yes | Alpha | no_content_schema |
| `getIntegrityReportFile` | GET | `/admin/integrity/report/{id}/file` | `maintenance` | yes | Alpha | binary |
| `getIntegrityReportCsv` | GET | `/admin/integrity/report/{type}/csv` | `maintenance` | yes | Alpha | binary |
| `getIntegrityReportSummary` | GET | `/admin/integrity/summary` | `maintenance` | yes | Alpha | json |
| `setMaintenanceMode` | POST | `/admin/maintenance` | `maintenance` | yes | Alpha | no_content_schema |
| `detectPriorInstall` | GET | `/admin/maintenance/detect-install` | `maintenance` | yes | Alpha | json |
| `maintenanceLogin` | POST | `/admin/maintenance/login` | `public` |  | Alpha | json |
| `getMaintenanceStatus` | GET | `/admin/maintenance/status` | `public` |  | Alpha | json |

### Map

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getMapMarkers` | GET | `/map/markers` | `map.read` |  | Stable | json |
| `reverseGeocode` | GET | `/map/reverse-geocode` | `map.search` |  | Stable | json |

### Memories

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `searchMemories` | GET | `/memories` | `memory.read` |  | Stable | json |
| `createMemory` | POST | `/memories` | `memory.create` |  | Stable | json |
| `memoriesStatistics` | GET | `/memories/statistics` | `memory.statistics` |  | Stable | json |
| `deleteMemory` | DELETE | `/memories/{id}` | `memory.delete` |  | Stable | no_content_schema |
| `getMemory` | GET | `/memories/{id}` | `memory.read` |  | Stable | json |
| `updateMemory` | PUT | `/memories/{id}` | `memory.update` |  | Deprecated | json |
| `removeMemoryAssets` | DELETE | `/memories/{id}/assets` | `memoryAsset.delete` |  | Stable | json |
| `addMemoryAssets` | PUT | `/memories/{id}/assets` | `memoryAsset.create` |  | Stable | json |

### Notifications

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `deleteNotifications` | DELETE | `/notifications` | `notification.delete` |  | Stable | no_content_schema |
| `getNotifications` | GET | `/notifications` | `notification.read` |  | Stable | json |
| `updateNotifications` | PUT | `/notifications` | `notification.update` |  | Stable | no_content_schema |
| `deleteNotification` | DELETE | `/notifications/{id}` | `notification.delete` |  | Stable | no_content_schema |
| `getNotification` | GET | `/notifications/{id}` | `notification.read` |  | Stable | json |
| `updateNotification` | PUT | `/notifications/{id}` | `notification.update` |  | Stable | json |

### Notifications (admin)

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `createNotification` | POST | `/admin/notifications` | `all (default)` | yes | Stable | json |
| `getNotificationTemplateAdmin` | POST | `/admin/notifications/templates/{name}` | `all (default)` | yes | Stable | json |
| `sendTestEmailAdmin` | POST | `/admin/notifications/test-email` | `all (default)` | yes | Stable | json |

### Partners

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getPartners` | GET | `/partners` | `partner.read` |  | Stable | json |
| `createPartner` | POST | `/partners` | `partner.create` |  | Stable | json |
| `removePartner` | DELETE | `/partners/{id}` | `partner.delete` |  | Stable | no_content_schema |
| `createPartnerDeprecated` | POST | `/partners/{id}` | `partner.create` |  | Deprecated | json |
| `updatePartner` | PUT | `/partners/{id}` | `partner.update` |  | Stable | json |

### People

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `deletePeople` | DELETE | `/people` | `person.delete` |  | Stable | no_content_schema |
| `getAllPeople` | GET | `/people` | `person.read` |  | Stable | json |
| `createPerson` | POST | `/people` | `person.create` |  | Stable | json |
| `updatePeople` | PUT | `/people` | `person.update` |  | Stable | json |
| `mergePeople` | POST | `/people/merge` | `person.merge` |  | Stable | json |
| `removeUsersFromPeople` | DELETE | `/people/users` | `person.update` |  | Beta | no_content_schema |
| `getUsersForPeople` | GET | `/people/users` | `person.read` |  | Beta | json |
| `upsertPeopleUsers` | PUT | `/people/users` | `person.update` |  | Beta | no_content_schema |
| `deletePerson` | DELETE | `/people/{id}` | `person.delete` |  | Stable | no_content_schema |
| `getPerson` | GET | `/people/{id}` | `person.read` |  | Stable | json |
| `updatePerson` | PUT | `/people/{id}` | `person.update` |  | Deprecated | json |
| `mergePersonLegacy` | POST | `/people/{id}/merge` | `person.merge` |  | Deprecated | json |
| `reassignFaces` | PUT | `/people/{id}/reassign` | `person.reassign` |  | Stable | json |
| `getPersonStatistics` | GET | `/people/{id}/statistics` | `person.statistics` |  | Stable | json |
| `getPersonThumbnail` | GET | `/people/{id}/thumbnail` | `person.read` |  | Stable | binary |

### Plugins

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `searchPlugins` | GET | `/plugins` | `plugin.read` |  | not specified | json |
| `searchPluginMethods` | GET | `/plugins/methods` | `plugin.read` |  | not specified | json |
| `searchPluginTemplates` | GET | `/plugins/templates` | `plugin.read` |  | not specified | json |
| `getPlugin` | GET | `/plugins/{id}` | `plugin.read` |  | not specified | json |

### Queues

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getQueues` | GET | `/queues` | `queue.read` | yes | Alpha | json |
| `getQueue` | GET | `/queues/{name}` | `queue.read` | yes | Alpha | json |
| `updateQueue` | PUT | `/queues/{name}` | `queue.update` | yes | Alpha | json |
| `emptyQueue` | DELETE | `/queues/{name}/jobs` | `queueJob.delete` | yes | Alpha | no_content_schema |
| `getQueueJobs` | GET | `/queues/{name}/jobs` | `queueJob.read` | yes | Alpha | json |

### Search

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAssetsByCity` | GET | `/search/cities` | `asset.read` |  | Stable | json |
| `getExploreData` | GET | `/search/explore` | `asset.read` |  | Stable | json |
| `searchLargeAssets` | POST | `/search/large-assets` | `asset.read` |  | Deprecated | json |
| `searchAssets` | POST | `/search/metadata` | `asset.read` |  | Stable | json |
| `searchPerson` | GET | `/search/person` | `person.read` |  | Stable | json |
| `searchPlaces` | GET | `/search/places` | `asset.read` |  | Stable | json |
| `searchRandom` | POST | `/search/random` | `asset.read` |  | Stable | json |
| `searchSmart` | POST | `/search/smart` | `asset.read` |  | Stable | json |
| `searchAssetStatistics` | POST | `/search/statistics` | `asset.statistics` |  | Stable | json |
| `getSearchSuggestions` | GET | `/search/suggestions` | `asset.read` |  | Stable | json |

### Server

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAboutInfo` | GET | `/server/about` | `server.about` |  | Stable | json |
| `getApkLinks` | GET | `/server/apk-links` | `server.apkLinks` |  | Stable | json |
| `getServerConfig` | GET | `/server/config` | `public` |  | Deprecated | json |
| `getServerFeatures` | GET | `/server/features` | `public` |  | Deprecated | json |
| `deleteServerLicense` | DELETE | `/server/license` | `serverLicense.delete` | yes | Stable | no_content_schema |
| `getServerLicense` | GET | `/server/license` | `serverLicense.read` | yes | Stable | json |
| `setServerLicense` | PUT | `/server/license` | `serverLicense.update` | yes | Stable | json |
| `getSupportedMediaTypes` | GET | `/server/media-types` | `public` |  | Stable | json |
| `pingServer` | GET | `/server/ping` | `public` |  | Stable | json |
| `getServerStatistics` | GET | `/server/statistics` | `server.statistics` | yes | Stable | json |
| `getStorage` | GET | `/server/storage` | `server.storage` |  | Stable | json |
| `getServerVersion` | GET | `/server/version` | `public` |  | Stable | json |
| `getVersionCheck` | GET | `/server/version-check` | `server.versionCheck` |  | Stable | json |
| `getVersionHistory` | GET | `/server/version-history` | `public` |  | Stable | json |

### Sessions

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `deleteAllSessions` | DELETE | `/sessions` | `session.delete` |  | Stable | no_content_schema |
| `getSessions` | GET | `/sessions` | `session.read` |  | Stable | json |
| `createSession` | POST | `/sessions` | `session.create` |  | Stable | json |
| `deleteSession` | DELETE | `/sessions/{id}` | `session.delete` |  | Stable | no_content_schema |
| `updateSession` | PUT | `/sessions/{id}` | `session.update` |  | Deprecated | json |
| `lockSession` | POST | `/sessions/{id}/lock` | `session.lock` |  | Stable | no_content_schema |

### Shared links

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAllSharedLinks` | GET | `/shared-links` | `sharedLink.read` |  | Stable | json |
| `createSharedLink` | POST | `/shared-links` | `sharedLink.create` |  | Stable | json |
| `sharedLinkLogin` | POST | `/shared-links/login` | `all (default)` |  | Beta | json |
| `getMySharedLink` | GET | `/shared-links/me` | `all (default)` |  | Stable | json |
| `removeSharedLink` | DELETE | `/shared-links/{id}` | `sharedLink.delete` |  | Stable | no_content_schema |
| `getSharedLinkById` | GET | `/shared-links/{id}` | `sharedLink.read` |  | Stable | json |
| `updateSharedLink` | PATCH | `/shared-links/{id}` | `sharedLink.update` |  | Stable | json |
| `removeSharedLinkAssets` | DELETE | `/shared-links/{id}/assets` | `sharedLink.update` |  | Stable | json |
| `addSharedLinkAssets` | PUT | `/shared-links/{id}/assets` | `sharedLink.update` |  | Stable | json |

### Stacks

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `deleteStacks` | DELETE | `/stacks` | `stack.delete` |  | Stable | no_content_schema |
| `searchStacks` | GET | `/stacks` | `stack.read` |  | Stable | json |
| `createStack` | POST | `/stacks` | `stack.create` |  | Stable | json |
| `deleteStack` | DELETE | `/stacks/{id}` | `stack.delete` |  | Stable | no_content_schema |
| `getStack` | GET | `/stacks/{id}` | `stack.read` |  | Stable | json |
| `updateStack` | PUT | `/stacks/{id}` | `stack.update` |  | Deprecated | json |
| `removeAssetFromStack` | DELETE | `/stacks/{id}/assets/{assetId}` | `stack.update` |  | Stable | no_content_schema |

### Sync

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `deleteSyncAck` | DELETE | `/sync/ack` | `syncCheckpoint.delete` |  | Stable | no_content_schema |
| `getSyncAck` | GET | `/sync/ack` | `syncCheckpoint.read` |  | Stable | json |
| `sendSyncAck` | POST | `/sync/ack` | `syncCheckpoint.update` |  | Stable | no_content_schema |
| `getSyncStream` | POST | `/sync/stream` | `sync.stream` |  | Stable | json_lines_stream |

### System config

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getConfig` | GET | `/system-config` | `systemConfig.read` | yes | Deprecated | json |
| `updateConfig` | PUT | `/system-config` | `systemConfig.update` | yes | Deprecated | json |
| `getConfigDefaults` | GET | `/system-config/defaults` | `systemConfig.read` | yes | Deprecated | json |
| `getStorageTemplateOptions` | GET | `/system-config/storage-template-options` | `systemConfig.read` | yes | Stable | json |

### System metadata

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAdminOnboarding` | GET | `/system-metadata/admin-onboarding` | `systemMetadata.read` | yes | Stable | json |
| `updateAdminOnboarding` | POST | `/system-metadata/admin-onboarding` | `systemMetadata.update` | yes | Stable | no_content_schema |
| `getReverseGeocodingState` | GET | `/system-metadata/reverse-geocoding-state` | `systemMetadata.read` | yes | Stable | json |
| `getVersionCheckState` | GET | `/system-metadata/version-check-state` | `systemMetadata.read` | yes | Stable | json |

### Tags

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAllTags` | GET | `/tags` | `tag.read` |  | Stable | json |
| `createTag` | POST | `/tags` | `tag.create` |  | Stable | json |
| `upsertTags` | PUT | `/tags` | `tag.create` |  | Stable | json |
| `bulkTagAssets` | PUT | `/tags/assets` | `tag.asset` |  | Stable | json |
| `deleteTag` | DELETE | `/tags/{id}` | `tag.delete` |  | Stable | no_content_schema |
| `getTagById` | GET | `/tags/{id}` | `tag.read` |  | Stable | json |
| `updateTag` | PUT | `/tags/{id}` | `tag.update` |  | Deprecated | json |
| `untagAssets` | DELETE | `/tags/{id}/assets` | `tag.asset` |  | Stable | json |
| `tagAssets` | PUT | `/tags/{id}/assets` | `tag.asset` |  | Stable | json |

### Timeline

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getTimeBucket` | GET | `/timeline/bucket` | `asset.read` |  | Internal | json |
| `getTimeBuckets` | GET | `/timeline/buckets` | `asset.read` |  | Internal | json |

### Trash

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `emptyTrash` | POST | `/trash/empty` | `asset.delete` |  | Stable | json |
| `restoreTrash` | POST | `/trash/restore` | `asset.delete` |  | Stable | json |
| `restoreAssets` | POST | `/trash/restore/assets` | `asset.delete` |  | Stable | json |

### Users

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `searchUsers` | GET | `/users` | `user.read` |  | Stable | json |
| `getMyUser` | GET | `/users/me` | `user.read` |  | Stable | json |
| `updateMyUser` | PUT | `/users/me` | `user.update` |  | Deprecated | json |
| `getMyCalendarHeatmap` | GET | `/users/me/calendar-heatmap` | `user.read` |  | Stable | json |
| `deleteUserLicense` | DELETE | `/users/me/license` | `userLicense.delete` |  | Stable | no_content_schema |
| `getUserLicense` | GET | `/users/me/license` | `userLicense.read` |  | Stable | json |
| `setUserLicense` | PUT | `/users/me/license` | `userLicense.update` |  | Stable | json |
| `deleteUserOnboarding` | DELETE | `/users/me/onboarding` | `userOnboarding.delete` |  | Stable | no_content_schema |
| `getUserOnboarding` | GET | `/users/me/onboarding` | `userOnboarding.read` |  | Stable | json |
| `setUserOnboarding` | PUT | `/users/me/onboarding` | `userOnboarding.update` |  | Stable | json |
| `getMyPreferences` | GET | `/users/me/preferences` | `userPreference.read` |  | Stable | json |
| `updateMyPreferences` | PUT | `/users/me/preferences` | `userPreference.update` |  | Deprecated | json |
| `deleteProfileImage` | DELETE | `/users/profile-image` | `userProfileImage.delete` |  | Stable | no_content_schema |
| `createProfileImage` | POST | `/users/profile-image` | `userProfileImage.update` |  | Stable | json |
| `getUser` | GET | `/users/{id}` | `user.read` |  | Stable | json |
| `getProfileImage` | GET | `/users/{id}/profile-image` | `userProfileImage.read` |  | Stable | binary |

### Users (admin)

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `searchUsersAdmin` | GET | `/admin/users` | `adminUser.read` | yes | Stable | json |
| `createUserAdmin` | POST | `/admin/users` | `adminUser.create` | yes | Stable | json |
| `deleteUserAdmin` | DELETE | `/admin/users/{id}` | `adminUser.delete` | yes | Stable | json |
| `getUserAdmin` | GET | `/admin/users/{id}` | `adminUser.read` | yes | Stable | json |
| `updateUserAdmin` | PUT | `/admin/users/{id}` | `adminUser.update` | yes | Deprecated | json |
| `getUserCalendarHeatmapAdmin` | GET | `/admin/users/{id}/calendar-heatmap` | `adminUser.read` | yes | Stable | json |
| `getUserPreferencesAdmin` | GET | `/admin/users/{id}/preferences` | `adminUser.read` | yes | Stable | json |
| `updateUserPreferencesAdmin` | PUT | `/admin/users/{id}/preferences` | `adminUser.update` | yes | Deprecated | json |
| `restoreUserAdmin` | POST | `/admin/users/{id}/restore` | `adminUser.delete` | yes | Stable | json |
| `getUserSessionsAdmin` | GET | `/admin/users/{id}/sessions` | `adminSession.read` | yes | Stable | json |
| `getUserStatisticsAdmin` | GET | `/admin/users/{id}/statistics` | `adminUser.read` | yes | Stable | json |

### Views

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `getAssetsByOriginalPath` | GET | `/view/folder` | `folder.read` |  | Stable | json |
| `getUniqueOriginalPaths` | GET | `/view/folder/unique-paths` | `folder.read` |  | Stable | json |

### Workflows

| Operation ID | Method | Path (under /api) | API-key permission | Admin | State | Response |
| --- | --- | --- | --- | --- | --- | --- |
| `searchWorkflows` | GET | `/workflows` | `workflow.read` |  | not specified | json |
| `createWorkflow` | POST | `/workflows` | `workflow.create` |  | not specified | json |
| `getWorkflowTriggers` | GET | `/workflows/triggers` | `no key-permission check` |  | not specified | json |
| `deleteWorkflow` | DELETE | `/workflows/{id}` | `workflow.delete` |  | not specified | no_content_schema |
| `getWorkflow` | GET | `/workflows/{id}` | `workflow.read` |  | not specified | json |
| `updateWorkflow` | PUT | `/workflows/{id}` | `workflow.update` |  | Deprecated | json |
| `getWorkflowLogs` | GET | `/workflows/{id}/logs` | `workflow.logs` |  | not specified | json |
| `getWorkflowForShare` | GET | `/workflows/{id}/share` | `workflow.read` |  | not specified | json |

## Runtime context exceptions confirmed in source

| Operation ID | Source constraint |
| --- | --- |
| `getMyApiKey` | API-key context required by ApiKeyService.getMine; bearer/cookie alternatives in OpenAPI are generic decorator output. |
| `createSession` | SessionService.create rejects API-key context; API key with all permissions is insufficient. |
| `lockAuthSession` | AuthService.lockSession requires auth.session; API key with all permissions is insufficient. |
| `unlockAuthSession` | AuthService.unlockSession requires auth.session and a valid PIN; API key with all permissions is insufficient. |
| `getSyncAck` | SyncService.getAcks requires auth.session and rejects API-key context. |
| `sendSyncAck` | SyncService.setAcks requires auth.session and rejects API-key context. |
| `deleteSyncAck` | SyncService.deleteAcks requires auth.session and rejects API-key context. |
| `getSyncStream` | SyncService.streamInternal requires auth.session and rejects API-key context. Response is JSON Lines despite absent OpenAPI response content. |
| `sharedLinkLogin` | SharedLinkService.login requires auth.sharedLink; ordinary user API-key context is insufficient. |
| `getMySharedLink` | SharedLinkService.getMine requires auth.sharedLink; ordinary user API-key context is insufficient. |
| `maintenanceLogin` | Normal MaintenanceController always returns Not in maintenance mode; actual behavior depends on maintenance process/state. |
| `startDatabaseRestoreFlow` | Public setup endpoint; initialization-state checks apply independently of API-key permissions. |
| `signUpAdmin` | Public setup endpoint; initialization-state checks apply independently of API-key permissions. |

## Schema supplements

- `getSyncStream` returns `Content-Type: application/jsonlines+json` with a JSON Lines stream (confirmed in `sync.controller.ts`). The OpenAPI 200 response has no content schema, so a generated JSON-only client is incomplete.
- File endpoints advertise `application/octet-stream`; preserve actual Content-Type, Content-Disposition, status, range semantics, and bytes.
- HLS playlist responses use `application/vnd.apple.mpegurl`; preserve playlist references and request headers `x-immich-hls-pos` and `x-immich-hls-msn`.
- Multipart operations: `uploadDatabaseBackup`, `uploadAsset`, `createProfileImage`. `uploadAsset` has both `assetData` and optional `sidecarData` file fields.
- `logoutOAuth` uses `application/x-www-form-urlencoded`.

## Hidden PATCH aliases present in source

The official OpenAPI contains the PUT forms with a deprecation history. The same release source also provides these PATCH aliases with `@ApiExcludeEndpoint()`. They implement the same operation and should be tracked separately from the 279 documented operations. Do not silently rewrite the canonical method merely because an alias exists.

| Hidden source method | HTTP path | Canonical OpenAPI operation |
| --- | --- | --- |
| `updateApiKeyV3` | `PATCH /api-keys/{id}` | `updateApiKey` |
| `updateAssetsV3` | `PATCH /assets` | `updateAssets` |
| `updateAssetV3` | `PATCH /assets/{id}` | `updateAsset` |
| `updateLibraryV3` | `PATCH /libraries/{id}` | `updateLibrary` |
| `updateMemoryV3` | `PATCH /memories/{id}` | `updateMemory` |
| `updatePersonV3` | `PATCH /people/{id}` | `updatePerson` |
| `updateSessionV3` | `PATCH /sessions/{id}` | `updateSession` |
| `updateStackV3` | `PATCH /stacks/{id}` | `updateStack` |
| `updateTagV3` | `PATCH /tags/{id}` | `updateTag` |
| `updateUserAdminV3` | `PATCH /admin/users/{id}` | `updateUserAdmin` |
| `updateUserPreferencesAdminV3` | `PATCH /admin/users/{id}/preferences` | `updateUserPreferencesAdmin` |
| `updateMyUserV3` | `PATCH /users/me` | `updateMyUser` |
| `updateMyPreferencesV3` | `PATCH /users/me/preferences` | `updateMyPreferences` |
| `updateWorkflowV3` | `PATCH /workflows/{id}` | `updateWorkflow` |

## Provenance

- [Pinned official OpenAPI](https://github.com/immich-app/immich/blob/8303cb117e197c700332b33b61b45314c9cc5bb4/open-api/immich-openapi-specs.json)
- [Pinned controllers](https://github.com/immich-app/immich/tree/8303cb117e197c700332b33b61b45314c9cc5bb4/server/src/controllers)
- `source-manifest.json` and `controllers-manifest.json` preserve exact source hashes.
