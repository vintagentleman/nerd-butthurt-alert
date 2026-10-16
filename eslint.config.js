import js from '@eslint/js';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import ts from 'typescript-eslint';

export default ts.config(
	{ ignores: ['node_modules', 'data', 'coverage'] },
	js.configs.recommended,
	...ts.configs.strict,
	...ts.configs.stylistic,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ['*.config.js'],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		plugins: { 'simple-import-sort': simpleImportSort },
		rules: {
			'simple-import-sort/imports': 'error',
			'simple-import-sort/exports': 'error',
		},
	},
);
