import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['web/**', 'node_modules/**', 'dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['server/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
);
