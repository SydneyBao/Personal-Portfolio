export function suppressedProjectSlugs(remoteProjects = [], deletedProjectSlugs = []) {
  const publishedSlugs = new Set(remoteProjects.map(({ slug }) => slug));
  return new Set(
    deletedProjectSlugs.filter((slug) => !publishedSlugs.has(slug)),
  );
}
