import registryDocument from './skill-frontmatter-capabilities.json' with { type: 'json' };

export * from '@lesliechan721/aw-plugin-core/manifest';

// Keep the CLI-reserved @aw/cli runtime export as an adapter-owned file.
export const skillFrontmatterCapabilityRegistryDocument = registryDocument;
