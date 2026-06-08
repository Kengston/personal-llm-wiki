import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'wiki-example/**',
			'docs/**',
			'compiler/**',
			'**/*.py',
			'*.config.*',
		],
	},
	...tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			// Порт текст-обработки иногда работает с динамическим JSON экспортов — any точечно допустим.
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
);
