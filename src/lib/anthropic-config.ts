/** Config key under which Settings persists the Anthropic API key (read by `#lib/anthropic`). Lives apart from `#lib/anthropic` so importing it does not pull the Anthropic SDK chunk into the Settings route. */
export const ANTHROPIC_API_KEY_CONFIG_KEY = "anthropic_api_key";
