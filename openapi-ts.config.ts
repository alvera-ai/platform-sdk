import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: './spec/openapi.yaml',
  output: 'src/generated',
  plugins: [
    '@hey-api/client-fetch',
    {
      name: 'valibot',
      definitions: true,
      requests: true,
      responses: true,
    },
    {
      name: '@hey-api/sdk',
      validator: 'valibot',
    },
  ],
});
