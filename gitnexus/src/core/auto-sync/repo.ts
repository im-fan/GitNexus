import { extractRepoName } from '../../server/git-clone.js';

export function extractRepoNameFromRemoteUrl(remoteUrl: string): string {
  return extractRepoName(remoteUrl);
}
