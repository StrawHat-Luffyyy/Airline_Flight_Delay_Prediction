import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const RAW_COLOUR = '/#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]|rgba?[(]|hsla?[(]/';
const RAW_COLOUR_MESSAGE =
  'Raw colour: use a token (CSS var / Tailwind theme name, or lib/tokens.ts in JS).';
const RAW_COLOUR_PENDING = ['web/src/components/globe/**'];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**', 'web/.impeccable/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['server/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    // Colours come from tokens (web/src/index.css, read in JS through web/src/lib/tokens.ts). A raw
    // hex or rgb()/hsl() anywhere else needs an inline
    // `// eslint-disable-next-line no-restricted-syntax -- <reason>`.
    files: ['web/src/**/*.{ts,tsx}'],
    ignores: [
      'web/src/lib/tokens.ts',
      // Not yet converted; each entry is removed by the commit that moves it onto tokens.
      ...RAW_COLOUR_PENDING,
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=${RAW_COLOUR}]`, message: RAW_COLOUR_MESSAGE },
        { selector: `TemplateElement[value.raw=${RAW_COLOUR}]`, message: RAW_COLOUR_MESSAGE },
      ],
    },
  },
);
