// The marketing screen reads Web Analytics for the public site. The project
// that serves shipousa.com is named in the repo as shipo-website1
// (src/app/api/website/route.ts and the analytics link on the marketing page).
// WEBSITE_VERCEL_PROJECT overrides that when the domain is attached to a
// different Vercel project.

export const WEBSITE_PROJECT_FALLBACK = 'shipo-website1'

export function websiteProjectName(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.WEBSITE_VERCEL_PROJECT?.trim()
  return named ? named : WEBSITE_PROJECT_FALLBACK
}
