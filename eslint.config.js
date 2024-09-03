<<<<<<< Updated upstream
'use strict';

module.exports = {
  root: true,
  parserOptions: {
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  env: {
    browser: true,
    es2022: true,
    mocha: true,
    node: true,
  },
  plugins: ['react', 'babel', 'jsdoc'],
  extends: [
    'prettier',
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:jsdoc/recommended',
  ],
  rules: {
    // Other rules
    'no-console': 'off',
    'eqeqeq': 'error',
    'react/display-name': 'off',
  },
};
=======
const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const jsdoc = require('eslint-plugin-jsdoc');
const babel = require('@babel/eslint-plugin');
const prettier = require('eslint-config-prettier');
const babelParser = require('@babel/eslint-parser');

module.exports = [
  js.configs.recommended,
  react.configs.flat.recommended,
  jsdoc.configs['flat/recommended'],
  prettier,
  {
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false, // Évite de devoir spécifier un fichier de configuration Babel
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
        ...globals.mocha,
      },
    },
    plugins: {
      'react': react,
      'jsdoc': jsdoc,
      '@babel': babel,
    },
    rules: {
      'eqeqeq': 'error',
      'no-console': 'off',
      'react/display-name': 'off',
      '@babel/no-unused-expressions': 'error', // Utilisation de règles spécifiques à Babel
      'no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'none',
          ignoreRestSiblings: true,
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
    },
    settings: {
      react: {
        version: 'detect',
      },
      jsdoc: {
        mode: 'typescript',
      },
    },
  },
];
>>>>>>> Stashed changes
