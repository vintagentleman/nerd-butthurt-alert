import js from '@eslint/js';
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
);
