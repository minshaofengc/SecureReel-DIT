// SPDX-License-Identifier: GPL-3.0-only
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
export interface Spec extends TurboModule {
  getSettings(): Promise<string>;
  saveSettings(settings: string): Promise<string>;
  runtimeStatus(): Promise<string>;
  requestNotifications(): Promise<boolean>;
  openBatterySettings(): Promise<void>;
  setKeepScreenOn(enabled: boolean): Promise<void>;
  scanPairingCode(): Promise<string>;
  pendingMutation(key: string, body: string): Promise<string>;
  getPendingMutation(key: string): Promise<string>;
  completeMutation(key: string): Promise<void>;
  storageAccess(): Promise<boolean>;
  requestStorageAccess(): Promise<boolean>;
  pickRoot(role: string): Promise<string>;
  roots(probeCopyTargets: boolean): Promise<string>;
  forgetRoot(rootId: string): Promise<void>;
  preflightJob(draft: string): Promise<string>;
  createJob(draft: string): Promise<string>;
  control(jobId: string, action: string): Promise<string>;
  snapshot(): Promise<string>;
  getJob(jobId: string): Promise<string>;
  saveProject(project: string): Promise<string>;
  saveReport(jobId: string, bundle: string): Promise<string>;
  reports(jobId: string): Promise<string>;
  shareReport(reportId: string, kind: string): Promise<boolean>;
  pairPeer(setup: string, deviceName: string): Promise<string>;
  peerInfo(): Promise<string>;
  forgetPeer(): Promise<void>;
  peerRequest(method: string, path: string, body: string): Promise<string>;
  sharePeerReport(path: string): Promise<boolean>;
}
export default TurboModuleRegistry.get<Spec>('SecureReel');
