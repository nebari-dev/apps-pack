import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { nebari } from '@nebari/starlight';
import { rehypeBaseLinks } from './src/rehype-base-links.mjs';

// Dynamic base. Production (main) uses the subpath: the portal Worker strips
// /nebari-apps-pack/ before proxying to this Pages project, so files are served
// from its root. PR previews build with BASE_PATH=/ because they are served at
// <alias>.pages.dev/ directly (no Worker). Astro emits files at dist/ root either
// way; base only prefixes link/asset URLs. Default is the production subpath so
// local builds and tests match production.
const base = process.env.BASE_PATH ?? '/nebari-apps-pack/';

export default defineConfig({
  site: 'https://packs.nebari.dev',
  base,
  // Astro does not prefix `base` onto root-absolute links written in Markdown body
  // content, so this rehype pass does it for internal links and images.
  markdown: { processor: unified({ rehypePlugins: [[rehypeBaseLinks, { base }]] }) },
  integrations: [
    starlight({
      title: 'Nebari Apps Pack',
      description:
        'Launch, manage, and observe static and Python web applications on a Nebari cluster - one App resource, reconciled into routing, TLS, and Keycloak SSO.',
      plugins: [nebari({ logoHref: 'https://packs.nebari.dev/' })],
      editLink: {
        // Starlight appends the source path (src/content/docs/<file>.md) to this
        // base, so it must point at the Astro project root inside the repo.
        baseUrl: 'https://github.com/nebari-dev/nebari-apps-pack/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', link: '/' },
            { label: 'Getting started', link: '/getting-started/' },
            { label: 'Launching apps', link: '/launching-apps/' },
            { label: 'MCP server', link: '/mcp/' },
            { label: 'Scaffolding skill', link: '/skill/' },
            { label: 'Local development', link: '/local-development/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'App CRD', link: '/app-crd-reference/' },
            { label: 'REST API', link: '/api-reference/' },
            { label: 'Architecture & auth', link: '/architecture/' },
          ],
        },
      ],
    }),
  ],
});
