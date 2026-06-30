export default {
	extends: ['@commitlint/config-conventional'],
	rules: {
		'scope-empty': [2, 'never'],
		'scope-enum': [
			2,
			'always',
			[
				'probe',
				'signals',
				'metrics',
				'storage',
				'config',
				'path',
				'grafana',
				'tooling',
				'docs',
				'deps',
			],
		],
		'subject-max-length': [2, 'always', 72],
	},
};
