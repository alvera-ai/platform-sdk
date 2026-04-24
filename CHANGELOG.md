# Changelog

## [0.5.1](https://github.com/alvera-ai/platform-sdk/compare/v0.5.0...v0.5.1) (2026-04-24)


### Bug Fixes

* **scripts:** relocate scripts tsconfig + annotate validator callbacks ([a4fb639](https://github.com/alvera-ai/platform-sdk/commit/a4fb639363fd75df20950256078dbc0acef9cce7))

## [0.5.0](https://github.com/alvera-ai/platform-sdk/compare/v0.4.1...v0.5.0) (2026-04-24)


### Features

* add agentic workflows, interop contracts, DAC CRUD + release 0.2.5 ([9309b4a](https://github.com/alvera-ai/platform-sdk/commit/9309b4a4909c0efbd16c85d67eba2bda999f4584))
* add alvera CLI with AWS-style profile config ([012a310](https://github.com/alvera-ai/platform-sdk/commit/012a310b903d1d5705c6751933f66ae484e8542a))
* add tenants list endpoint + CLI command ([8bb605a](https://github.com/alvera-ai/platform-sdk/commit/8bb605a4fd54d21b3a3a54aef116f68abe3f631c))
* add valibot runtime validation for all requests and responses ([436cb27](https://github.com/alvera-ai/platform-sdk/commit/436cb27834fb7b4181de2b843a134e854ab1c98d))
* **cli:** add -v / --version flag ([93d3458](https://github.com/alvera-ai/platform-sdk/commit/93d34585a7466e1986f450914c5dde241c374d3e))
* extend SDK/CLI with connected-apps, workflows, MDM, datasets, and session verify ([e537774](https://github.com/alvera-ai/platform-sdk/commit/e537774176ae4205bbb1bb3d64f57e33bf4aa536))
* move upload-link from DAC to datalake scope + release 0.2.3 ([0ee0a17](https://github.com/alvera-ai/platform-sdk/commit/0ee0a17f80954077b2b02d0629bf532e8a9a5f1e))
* multi-env from OpenAPI servers[] + release-please ([#1](https://github.com/alvera-ai/platform-sdk/issues/1)) ([199e661](https://github.com/alvera-ai/platform-sdk/commit/199e661929ec92801306508dce88a111af8c8f21))
* switch to session-based auth and bump to 0.2.0 ([70e5814](https://github.com/alvera-ai/platform-sdk/commit/70e5814f9bfdd9dbda792dd7d6e574423ef85301))


### Bug Fixes

* **ci:** bump Node to 24 + actions to v6 so trusted publishing actually works ([9790b93](https://github.com/alvera-ai/platform-sdk/commit/9790b933fa3cd508d0766fa02514f8b1c69ffa18))
* **ci:** pin packageManager so pnpm/action-setup can resolve a version ([b9f09ec](https://github.com/alvera-ai/platform-sdk/commit/b9f09ece846252e6fccc5731e5dc8e60b163b4b3))
* **ci:** run gen-environments before codegen in release workflow ([2b4aa92](https://github.com/alvera-ai/platform-sdk/commit/2b4aa923394755cd5e41530108f3974f77009365))
* **ci:** use GitHub App token for release-please ([55d795a](https://github.com/alvera-ai/platform-sdk/commit/55d795aed1b44d277c122f8fea956b3d9f2af540))
* **ci:** use GitHub App token for release-please so tag push triggers publish ([#7](https://github.com/alvera-ai/platform-sdk/issues/7)) ([7eea820](https://github.com/alvera-ai/platform-sdk/commit/7eea82096fc20595cc81bb5bef196e84f6323d0f))
* **cli:** render API error bodies instead of [object Object] ([2d5226f](https://github.com/alvera-ai/platform-sdk/commit/2d5226fd87286aa58c6bd9f81ec5fd3adcbb9983))
* **release-please:** drop component prefix from tag names ([2702908](https://github.com/alvera-ai/platform-sdk/commit/270290819cfa3a516f1855307da9ccff48d99d8f))
* **release-please:** drop component prefix from tag names ([#4](https://github.com/alvera-ai/platform-sdk/issues/4)) ([b1f51f6](https://github.com/alvera-ai/platform-sdk/commit/b1f51f64ad0f418f9878c136c53a67bcd3d77bd5))

## [0.4.1](https://github.com/alvera-ai/platform-sdk/compare/v0.4.0...v0.4.1) (2026-04-24)


### Bug Fixes

* **ci:** use GitHub App token for release-please ([9c8ffae](https://github.com/alvera-ai/platform-sdk/commit/9c8ffae5ea7ae76ae479fd868add957b1a62353d))
* **ci:** use GitHub App token for release-please so tag push triggers publish ([#7](https://github.com/alvera-ai/platform-sdk/issues/7)) ([162945c](https://github.com/alvera-ai/platform-sdk/commit/162945c12a8d16bad5bf52b9936ce7d18ad89369))

## [0.4.0](https://github.com/alvera-ai/platform-sdk/compare/v0.3.0...v0.4.0) (2026-04-24)


### Features

* add agentic workflows, interop contracts, DAC CRUD + release 0.2.5 ([39c340f](https://github.com/alvera-ai/platform-sdk/commit/39c340f00c72d832836cb7885fb1e450860ec373))
* add alvera CLI with AWS-style profile config ([0a039d3](https://github.com/alvera-ai/platform-sdk/commit/0a039d3d1a8bffd2f7dccccb11da29296135067e))
* add tenants list endpoint + CLI command ([d773374](https://github.com/alvera-ai/platform-sdk/commit/d7733746259e281aa8b28e70362e8b2c538aa77a))
* add valibot runtime validation for all requests and responses ([0b43208](https://github.com/alvera-ai/platform-sdk/commit/0b43208f1ecf2a66fcf5b8ec7e456cd13012fce2))
* **cli:** add -v / --version flag ([8fa0e0f](https://github.com/alvera-ai/platform-sdk/commit/8fa0e0f9ee5d5868e0d4de32f8475f1feede3ce1))
* extend SDK/CLI with connected-apps, workflows, MDM, datasets, and session verify ([b0fe588](https://github.com/alvera-ai/platform-sdk/commit/b0fe588b2b78dec8b049ea2b365f4088bb72be2b))
* move upload-link from DAC to datalake scope + release 0.2.3 ([e2cd256](https://github.com/alvera-ai/platform-sdk/commit/e2cd256a0693d578b9e6d15ad4a3a2ab1bd6b591))
* multi-env from OpenAPI servers[] + release-please ([#1](https://github.com/alvera-ai/platform-sdk/issues/1)) ([41c6542](https://github.com/alvera-ai/platform-sdk/commit/41c6542186a61482930b468e8350b097a56485d5))
* switch to session-based auth and bump to 0.2.0 ([e0bcf64](https://github.com/alvera-ai/platform-sdk/commit/e0bcf6453ad65984fa985da3fbb22956e400c628))


### Bug Fixes

* **ci:** bump Node to 24 + actions to v6 so trusted publishing actually works ([01fc678](https://github.com/alvera-ai/platform-sdk/commit/01fc6783cc33ec9daa3cf640ecda8bad1c6bea9a))
* **ci:** pin packageManager so pnpm/action-setup can resolve a version ([23ce360](https://github.com/alvera-ai/platform-sdk/commit/23ce360fc95e4a11fb4f920141ba9ace37b9f2c7))
* **ci:** run gen-environments before codegen in release workflow ([166f40f](https://github.com/alvera-ai/platform-sdk/commit/166f40f7b7901334e433cd22791d4a9c1a1f8340))
* **cli:** render API error bodies instead of [object Object] ([c56d759](https://github.com/alvera-ai/platform-sdk/commit/c56d759fba3a6744f987126fca3f829ecddade8a))
* **release-please:** drop component prefix from tag names ([e9b012f](https://github.com/alvera-ai/platform-sdk/commit/e9b012fa9d3fd83d1d0f66807ee6bf02bcffc326))
* **release-please:** drop component prefix from tag names ([#4](https://github.com/alvera-ai/platform-sdk/issues/4)) ([47e0958](https://github.com/alvera-ai/platform-sdk/commit/47e0958b8fe543ec578e9adc3238c5fe2e767c7a))

## [0.3.0](https://github.com/alvera-ai/platform-sdk/compare/platform-sdk-v0.2.5...platform-sdk-v0.3.0) (2026-04-24)


### Features

* add agentic workflows, interop contracts, DAC CRUD + release 0.2.5 ([39c340f](https://github.com/alvera-ai/platform-sdk/commit/39c340f00c72d832836cb7885fb1e450860ec373))
* add alvera CLI with AWS-style profile config ([0a039d3](https://github.com/alvera-ai/platform-sdk/commit/0a039d3d1a8bffd2f7dccccb11da29296135067e))
* add tenants list endpoint + CLI command ([d773374](https://github.com/alvera-ai/platform-sdk/commit/d7733746259e281aa8b28e70362e8b2c538aa77a))
* add valibot runtime validation for all requests and responses ([0b43208](https://github.com/alvera-ai/platform-sdk/commit/0b43208f1ecf2a66fcf5b8ec7e456cd13012fce2))
* **cli:** add -v / --version flag ([8fa0e0f](https://github.com/alvera-ai/platform-sdk/commit/8fa0e0f9ee5d5868e0d4de32f8475f1feede3ce1))
* extend SDK/CLI with connected-apps, workflows, MDM, datasets, and session verify ([b0fe588](https://github.com/alvera-ai/platform-sdk/commit/b0fe588b2b78dec8b049ea2b365f4088bb72be2b))
* move upload-link from DAC to datalake scope + release 0.2.3 ([e2cd256](https://github.com/alvera-ai/platform-sdk/commit/e2cd256a0693d578b9e6d15ad4a3a2ab1bd6b591))
* multi-env from OpenAPI servers[] + release-please ([#1](https://github.com/alvera-ai/platform-sdk/issues/1)) ([41c6542](https://github.com/alvera-ai/platform-sdk/commit/41c6542186a61482930b468e8350b097a56485d5))
* switch to session-based auth and bump to 0.2.0 ([e0bcf64](https://github.com/alvera-ai/platform-sdk/commit/e0bcf6453ad65984fa985da3fbb22956e400c628))


### Bug Fixes

* **ci:** bump Node to 24 + actions to v6 so trusted publishing actually works ([01fc678](https://github.com/alvera-ai/platform-sdk/commit/01fc6783cc33ec9daa3cf640ecda8bad1c6bea9a))
* **ci:** pin packageManager so pnpm/action-setup can resolve a version ([23ce360](https://github.com/alvera-ai/platform-sdk/commit/23ce360fc95e4a11fb4f920141ba9ace37b9f2c7))
* **ci:** run gen-environments before codegen in release workflow ([166f40f](https://github.com/alvera-ai/platform-sdk/commit/166f40f7b7901334e433cd22791d4a9c1a1f8340))
* **cli:** render API error bodies instead of [object Object] ([c56d759](https://github.com/alvera-ai/platform-sdk/commit/c56d759fba3a6744f987126fca3f829ecddade8a))

## Changelog

Release notes are generated automatically by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/) on `main`.
