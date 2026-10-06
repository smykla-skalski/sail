export type TaskLocation = {
  directory: string;
  repository: string;
  branch: string;
  known: boolean;
};

function locationName(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
}

function validMetadata(value: string): boolean {
  if (!value.trim()) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export function resolveTaskLocation(
  directory: string,
  repository: string,
  branch: string | null | undefined,
): TaskLocation {
  const repositoryName = validMetadata(repository) ? locationName(repository).trim() : '';
  const branchName = typeof branch === 'string' && validMetadata(branch) ? branch.trim() : '';
  return {
    directory,
    repository: repositoryName,
    branch: branchName,
    known: validMetadata(directory) && !!repositoryName && !!branchName,
  };
}

export function composerTaskLocation(
  location: TaskLocation,
  directory: string,
  threadDirectory?: string,
): TaskLocation {
  if (
    !validMetadata(directory) ||
    location.directory !== directory ||
    (threadDirectory !== undefined && threadDirectory !== directory)
  )
    return resolveTaskLocation(directory, '', null);
  return location;
}
