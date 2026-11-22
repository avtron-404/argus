import os
import json
from typing import List, Optional, Union, Dict, Any
import requests
from dotenv import load_dotenv

load_dotenv()

# Cloud and Local Provider Defaults
DEFAULT_CASCADE_ORDER = ["groq", "gemini", "openrouter", "openai", "ollama"]

# Groq settings
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b"

# Gemini settings (OpenAI-compatible)
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"

# OpenRouter settings (OpenAI-compatible)
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini"

# OpenAI settings
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"

# Ollama settings
DEFAULT_OLLAMA_URL = "http://localhost:11434/api/generate"
DEFAULT_OLLAMA_MODEL = "llama3.2:latest"


class LLMServiceError(Exception):
    """Custom exception raised when LLM generation fails across providers."""
    pass


def get_provider_config(provider_name: str) -> Optional[Dict[str, Any]]:
    """
    Retrieve live configuration for a specified provider.
    Reads dynamically from os.environ so runtime updates are respected.
    """
    name = provider_name.lower().strip()

    if name == "groq":
        return {
            "id": "groq",
            "name": "Groq",
            "type": "cloud",
            "url": GROQ_URL,
            "api_key": os.getenv("GROQ_API_KEY", "").strip(),
            "model": os.getenv("GROQ_MODEL", DEFAULT_GROQ_MODEL).strip()
        }
    elif name == "gemini":
        return {
            "id": "gemini",
            "name": "Gemini",
            "type": "cloud",
            "url": GEMINI_URL,
            "api_key": os.getenv("GEMINI_API_KEY", "").strip(),
            "model": os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
        }
    elif name == "openrouter":
        api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
        if not api_key:
            # Fallback if user placed OpenRouter key in OPENAI_API_KEY
            fallback_key = os.getenv("OPENAI_API_KEY", "").strip()
            if fallback_key.startswith("sk-or-"):
                api_key = fallback_key
        if api_key.startswith("your_") or "openrouter_api_key" in api_key.lower():
            api_key = ""
        return {
            "id": "openrouter",
            "name": "OpenRouter",
            "type": "cloud",
            "url": os.getenv("OPENROUTER_URL", OPENROUTER_URL).strip(),
            "api_key": api_key,
            "model": os.getenv("OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL).strip()
        }
    elif name == "openai":
        return {
            "id": "openai",
            "name": "OpenAI",
            "type": "cloud",
            "url": OPENAI_URL,
            "api_key": os.getenv("OPENAI_API_KEY", "").strip(),
            "model": os.getenv("OPENAI_MODEL", DEFAULT_OPENAI_MODEL).strip()
        }
    elif name == "ollama":
        return {
            "id": "ollama",
            "name": "Ollama",
            "type": "ollama",
            "url": os.getenv("OLLAMA_URL", DEFAULT_OLLAMA_URL).strip(),
            "api_key": "",
            "model": os.getenv("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL).strip()
        }
    return None


def get_active_provider_chain(custom_chain: Optional[List[str]] = None) -> List[str]:
    """
    Returns the ordered list of provider names to try.
    Cascade logic:
    1. If custom_chain is provided, use it.
    2. Else if LLM_FALLBACK_CHAIN is set in env, parse comma-separated providers.
    3. Else build intelligent cascade:
       - Check LLM_PROVIDER (e.g. 'gemini', 'groq', 'ollama'). If set, prioritize it.
       - Cloud providers (Groq -> Gemini -> OpenAI) are included if their API key is present.
       - Ollama is included as offline fallback.
       - If no cloud keys exist and LLM_PROVIDER is unset, returns ['ollama'].
    """
    if custom_chain:
        return [p.lower().strip() for p in custom_chain if get_provider_config(p)]

    env_chain = os.getenv("LLM_FALLBACK_CHAIN", "").strip()
    if env_chain:
        parsed = [p.lower().strip() for p in env_chain.split(",") if p.strip()]
        valid = [p for p in parsed if get_provider_config(p)]
        if valid:
            return valid

    preferred_provider = os.getenv("LLM_PROVIDER", "").lower().strip()

    # Discover which cloud providers have API keys configured
    available_cloud = []
    for p in ["groq", "gemini", "openrouter", "openai"]:
        cfg = get_provider_config(p)
        if cfg and cfg["api_key"]:
            available_cloud.append(p)

    chain: List[str] = []

    if preferred_provider == "ollama":
        chain = ["ollama"] + available_cloud
    elif preferred_provider in available_cloud:
        chain = [preferred_provider] + [p for p in available_cloud if p != preferred_provider] + ["ollama"]
    else:
        # Default smart priority: fastest/highest quota cloud first, ollama offline fallback
        chain = available_cloud + ["ollama"]

    # Remove duplicates while preserving order
    seen = set()
    deduped = []
    for item in chain:
        if item not in seen:
            seen.add(item)
            deduped.append(item)

    return deduped if deduped else ["ollama"]


def get_active_vision_provider_chain() -> List[str]:
    """
    Returns the ordered list of vision-capable providers.
    Gemini, OpenRouter, and OpenAI are multimodal.
    """
    preferred_order = ["gemini", "openrouter", "openai"]
    chain = []
    for p in preferred_order:
        cfg = get_provider_config(p)
        if cfg and cfg.get("api_key"):
            chain.append(p)
    return chain if chain else ["gemini", "openrouter"]


# Active primary provider exported for status checks and backward compatibility
active_chain = get_active_provider_chain()
LLM_PROVIDER = active_chain[0] if active_chain else "ollama"


def _extract_http_error(e: requests.exceptions.HTTPError, provider_name: str) -> str:
    """Helper to extract a clear, human-readable error description from HTTP errors."""
    status_code = e.response.status_code if e.response is not None else "Unknown"
    detail = ""
    if e.response is not None:
        try:
            err_json = e.response.json()
            if isinstance(err_json, list) and len(err_json) > 0 and isinstance(err_json[0], dict):
                err_json = err_json[0]
            if isinstance(err_json, dict):
                if "error" in err_json and isinstance(err_json["error"], dict):
                    detail = err_json["error"].get("message", "")
                elif "message" in err_json:
                    detail = err_json.get("message", "")
        except Exception:
            detail = e.response.text

    if not detail:
        detail = str(e)

    if len(detail) > 120:
        detail = detail[:117] + "..."

    return f"{provider_name} returned HTTP {status_code}: {detail}"


def _generate_with_ollama(prompt: str) -> str:
    cfg = get_provider_config("ollama")
    url = cfg["url"]
    model = cfg["model"]

    try:
        response = requests.post(
            url,
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": 0.2
                }
            },
            timeout=45
        )
        response.raise_for_status()
        data = response.json()
        return data.get("response", "").strip()

    except requests.exceptions.ConnectionError:
        raise LLMServiceError(
            f"Cannot connect to Ollama at {url}. Ensure Ollama is running (`ollama serve`)."
        )
    except requests.exceptions.HTTPError as e:
        raise LLMServiceError(_extract_http_error(e, "Ollama"))
    except requests.exceptions.Timeout:
        raise LLMServiceError("Ollama request timed out after 45 seconds.")


def _stream_with_ollama(prompt: str):
    cfg = get_provider_config("ollama")
    url = cfg["url"]
    model = cfg["model"]

    try:
        response = requests.post(
            url,
            json={
                "model": model,
                "prompt": prompt,
                "stream": True,
                "options": {
                    "temperature": 0.2
                }
            },
            stream=True,
            timeout=45
        )
        response.raise_for_status()

        for line in response.iter_lines():
            if line:
                data = json.loads(line.decode("utf-8"))
                token = data.get("response", "")
                if token:
                    yield token
                if data.get("done", False):
                    break

    except requests.exceptions.ConnectionError:
        raise LLMServiceError(
            f"Cannot connect to Ollama at {url}. Ensure Ollama is running (`ollama serve`)."
        )
    except requests.exceptions.HTTPError as e:
        raise LLMServiceError(_extract_http_error(e, "Ollama"))
    except requests.exceptions.Timeout:
        raise LLMServiceError("Ollama stream timed out after 45 seconds.")


def _generate_with_cloud(api_url: str, api_key: str, model: str, prompt: str, provider_name: str) -> str:
    if not api_key:
        raise LLMServiceError(
            f"{provider_name} API key not found. Please set {provider_name.upper()}_API_KEY."
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    if provider_name.lower() == "openrouter":
        headers["HTTP-Referer"] = "http://localhost:8000"
        headers["X-Title"] = "Argus"

    try:
        response = requests.post(
            api_url,
            headers=headers,
            json={
                "model": model,
                "messages": [
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.2
            },
            timeout=25
        )
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"].strip()

    except requests.exceptions.ConnectionError:
        raise LLMServiceError(f"Network error connecting to {provider_name} API.")
    except requests.exceptions.HTTPError as e:
        raise LLMServiceError(_extract_http_error(e, provider_name))
    except requests.exceptions.Timeout:
        raise LLMServiceError(f"{provider_name} request timed out after 25 seconds.")


def _stream_with_cloud(api_url: str, api_key: str, model: str, prompt: str, provider_name: str):
    if not api_key:
        raise LLMServiceError(
            f"{provider_name} API key not found. Please set {provider_name.upper()}_API_KEY."
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    if provider_name.lower() == "openrouter":
        headers["HTTP-Referer"] = "http://localhost:8000"
        headers["X-Title"] = "Argus"

    try:
        response = requests.post(
            api_url,
            headers=headers,
            json={
                "model": model,
                "messages": [
                    {"role": "user", "content": prompt}
                ],
                "stream": True,
                "temperature": 0.2
            },
            stream=True,
            timeout=25
        )
        response.raise_for_status()

        for line in response.iter_lines():
            if line:
                decoded = line.decode("utf-8").strip()
                if decoded.startswith("data: "):
                    payload = decoded[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        data = json.loads(payload)
                        choices = data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            token = delta.get("content", "")
                            if token:
                                yield token
                    except json.JSONDecodeError:
                        continue

    except requests.exceptions.ConnectionError:
        raise LLMServiceError(f"Network error connecting to {provider_name} API.")
    except requests.exceptions.HTTPError as e:
        raise LLMServiceError(_extract_http_error(e, provider_name))
    except requests.exceptions.Timeout:
        raise LLMServiceError(f"{provider_name} stream timed out after 25 seconds.")


def generate_answer(
    prompt: str,
    fallback_chain: Optional[List[str]] = None,
    return_details: bool = False
) -> Union[str, Dict[str, Any]]:
    """
    Generate an answer synchronously using the automatic cascading failover chain.
    If the primary provider fails, automatically switches to subsequent providers.
    """
    chain = get_active_provider_chain(fallback_chain)
    if not chain:
        raise LLMServiceError("No LLM providers configured. Set an API key or ensure Ollama is available.")

    attempt_errors = []
    failover_notices = []

    for idx, provider_name in enumerate(chain):
        cfg = get_provider_config(provider_name)
        if not cfg:
            continue

        try:
            print(f"[*] Attempting generation via provider: [{cfg['name']}] ({cfg['model']})")
            if cfg["type"] == "cloud":
                answer = _generate_with_cloud(
                    cfg["url"], cfg["api_key"], cfg["model"], prompt, cfg["name"]
                )
            else:
                answer = _generate_with_ollama(prompt)

            print(f"[*] Response successfully generated using [{cfg['name']}]")
            if return_details:
                return {
                    "answer": answer,
                    "provider": cfg["name"],
                    "model": cfg["model"],
                    "failovers": failover_notices
                }
            return answer

        except Exception as e:
            err_msg = str(e)
            print(f"[*] Failover warning: Provider [{cfg['name']}] failed: {err_msg}")
            attempt_errors.append((cfg["name"], err_msg))
            if idx + 1 < len(chain):
                next_p = get_provider_config(chain[idx + 1])
                next_name = next_p["name"] if next_p else chain[idx + 1]
                failover_notices.append(f"Failover: {cfg['name']} unavailable -> Switched to {next_name}")

    summary = "\n".join(f"  - {p}: {err}" for p, err in attempt_errors)
    raise LLMServiceError(f"All configured LLM providers failed:\n{summary}")


def stream_answer_events(
    prompt: str,
    fallback_chain: Optional[List[str]] = None
):
    """
    Generator yielding SSE events:
    - {"type": "agent_step", "step": "..."}
    - {"type": "token", "token": "..."}

    Automatically fails over to the next provider in the chain if a provider
    encounters a connection error, HTTP 429, timeout, or authentication failure
    before yielding tokens.
    """
    chain = get_active_provider_chain(fallback_chain)
    if not chain:
        raise LLMServiceError("No LLM providers configured. Set an API key or ensure Ollama is available.")

    attempt_errors = []

    for idx, provider_name in enumerate(chain):
        cfg = get_provider_config(provider_name)
        if not cfg:
            continue

        yield {
            "type": "agent_step",
            "step": f"LLM: Connecting to {cfg['name']} ({cfg['model']})"
        }

        try:
            if cfg["type"] == "cloud":
                gen = _stream_with_cloud(cfg["url"], cfg["api_key"], cfg["model"], prompt, cfg["name"])
            else:
                gen = _stream_with_ollama(prompt)

            # Test connection & fetch initial token before committing to this stream
            try:
                first_token = next(gen)
            except StopIteration:
                # Provider returned 0 tokens
                return

            # Successfully verified provider connection! Stream all tokens.
            yield {"type": "token", "token": first_token}
            for token in gen:
                yield {"type": "token", "token": token}

            # Generation completed successfully with this provider
            return

        except Exception as e:
            err_msg = str(e)
            attempt_errors.append((cfg["name"], err_msg))
            if idx + 1 < len(chain):
                next_p = get_provider_config(chain[idx + 1])
                next_name = next_p["name"] if next_p else chain[idx + 1]
                print(f"[*] Failover warning: [{cfg['name']}] failed ({err_msg}). Switching to [{next_name}]")
                yield {
                    "type": "agent_step",
                    "step": f"Failover: {cfg['name']} unavailable -> Switched to {next_name}"
                }
            else:
                print(f"[*] Provider [{cfg['name']}] failed: {err_msg} (no further providers in chain)")

    summary = "; ".join(f"{p}: {err}" for p, err in attempt_errors)
    raise LLMServiceError(f"All LLM providers failed: {summary}")


def stream_answer(prompt: str, fallback_chain: Optional[List[str]] = None):
    """
    Yields tokens incrementally using the automatic failover cascade.
    """
    for event in stream_answer_events(prompt, fallback_chain=fallback_chain):
        if event.get("type") == "token":
            yield event.get("token", "")


# ===========================================================================
# MULTIMODAL VISION & OCR CAPABILITIES (APPROACHES 1 & 2)
# ===========================================================================

def _prepare_data_uri(image_base64: str, mime_type: str = "image/png") -> str:
    """Ensure the base64 string is properly formatted as a data URI."""
    clean = image_base64.strip()
    if clean.startswith("data:"):
        return clean
    return f"data:{mime_type};base64,{clean}"


def _generate_vision_with_cloud(
    api_url: str,
    api_key: str,
    model: str,
    prompt: str,
    image_base64: str,
    mime_type: str,
    provider_name: str
) -> str:
    """Generate synchronous response for a multimodal prompt with an image."""
    if not api_key:
        raise LLMServiceError(f"{provider_name} API key not found for vision.")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    if provider_name.lower() == "openrouter":
        headers["HTTP-Referer"] = "http://localhost:8000"
        headers["X-Title"] = "Argus"

    data_uri = _prepare_data_uri(image_base64, mime_type)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": data_uri
                    }
                }
            ]
        }
    ]

    try:
        response = requests.post(
            api_url,
            headers=headers,
            json={
                "model": model,
                "messages": messages,
                "temperature": 0.2
            },
            timeout=30
        )
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"].strip()
    except requests.exceptions.ConnectionError:
        raise LLMServiceError(f"Network error connecting to {provider_name} Vision API.")
    except requests.exceptions.HTTPError as e:
        raise LLMServiceError(_extract_http_error(e, provider_name))
    except requests.exceptions.Timeout:
        raise LLMServiceError(f"{provider_name} Vision request timed out after 30 seconds.")


def _stream_vision_with_cloud(
    api_url: str,
    api_key: str,
    model: str,
    prompt: str,
    image_base64: str,
    mime_type: str,
    provider_name: str
):
    """Stream response tokens for a multimodal prompt with an image."""
    if not api_key:
        raise LLMServiceError(f"{provider_name} API key not found for vision.")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    if provider_name.lower() == "openrouter":
        headers["HTTP-Referer"] = "http://localhost:8000"
        headers["X-Title"] = "Argus"

    data_uri = _prepare_data_uri(image_base64, mime_type)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": data_uri
                    }
                }
            ]
        }
    ]

    try:
        response = requests.post(
            api_url,
            headers=headers,
            json={
                "model": model,
                "messages": messages,
                "stream": True,
                "temperature": 0.2
            },
            stream=True,
            timeout=30
        )
        response.raise_for_status()

        for line in response.iter_lines():
            if line:
                decoded = line.decode("utf-8").strip()
                if decoded.startswith("data: "):
                    payload = decoded[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        data = json.loads(payload)
                        choices = data.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            token = delta.get("content", "")
                            if token:
                                yield token
                    except json.JSONDecodeError:
                        continue
    except requests.exceptions.ConnectionError:
        raise LLMServiceError(f"Network error connecting to {provider_name} Vision API.")
    except requests.exceptions.HTTPError as e:
        raise LLMServiceError(_extract_http_error(e, provider_name))
    except requests.exceptions.Timeout:
        raise LLMServiceError(f"{provider_name} Vision stream timed out after 30 seconds.")


def generate_vision_answer(
    prompt: str,
    image_base64: str,
    mime_type: str = "image/png",
    return_details: bool = False
) -> Union[str, Dict[str, Any]]:
    """
    Synchronous multimodal vision generation using failover across vision-capable providers.
    """
    chain = get_active_vision_provider_chain()
    if not chain:
        raise LLMServiceError("No multimodal Vision providers configured. Set GEMINI_API_KEY or OPENROUTER_API_KEY.")

    attempt_errors = []
    failover_notices = []

    for idx, provider_name in enumerate(chain):
        cfg = get_provider_config(provider_name)
        if not cfg or not cfg.get("api_key"):
            continue

        try:
            print(f"[*] Attempting Vision generation via: [{cfg['name']}] ({cfg['model']})")
            answer = _generate_vision_with_cloud(
                cfg["url"], cfg["api_key"], cfg["model"], prompt, image_base64, mime_type, cfg["name"]
            )
            print(f"[*] Vision answer successfully generated using [{cfg['name']}]")
            if return_details:
                return {
                    "answer": answer,
                    "provider": cfg["name"],
                    "model": cfg["model"],
                    "failovers": failover_notices
                }
            return answer
        except Exception as e:
            err_msg = str(e)
            print(f"[*] Vision failover: [{cfg['name']}] failed: {err_msg}")
            attempt_errors.append((cfg["name"], err_msg))
            if idx + 1 < len(chain):
                next_p = get_provider_config(chain[idx + 1])
                next_name = next_p["name"] if next_p else chain[idx + 1]
                failover_notices.append(f"Vision Failover: {cfg['name']} -> {next_name}")

    summary = "\n".join(f"  - {p}: {err}" for p, err in attempt_errors)
    raise LLMServiceError(f"All Vision providers failed:\n{summary}")


def stream_vision_answer_events(
    prompt: str,
    image_base64: str,
    mime_type: str = "image/png"
):
    """
    Stream SSE events for a multimodal image + text question.
    """
    chain = get_active_vision_provider_chain()
    if not chain:
        raise LLMServiceError("No multimodal Vision providers configured. Set GEMINI_API_KEY or OPENROUTER_API_KEY.")

    attempt_errors = []

    for idx, provider_name in enumerate(chain):
        cfg = get_provider_config(provider_name)
        if not cfg or not cfg.get("api_key"):
            continue

        yield {
            "type": "agent_step",
            "step": f"Vision: Connecting to {cfg['name']} ({cfg['model']})"
        }

        try:
            gen = _stream_vision_with_cloud(
                cfg["url"], cfg["api_key"], cfg["model"], prompt, image_base64, mime_type, cfg["name"]
            )

            try:
                first_token = next(gen)
            except StopIteration:
                return

            yield {"type": "token", "token": first_token}
            for token in gen:
                yield {"type": "token", "token": token}
            return

        except Exception as e:
            err_msg = str(e)
            attempt_errors.append((cfg["name"], err_msg))
            if idx + 1 < len(chain):
                next_p = get_provider_config(chain[idx + 1])
                next_name = next_p["name"] if next_p else chain[idx + 1]
                print(f"[*] Vision failover: [{cfg['name']}] failed ({err_msg}). Switching to [{next_name}]")
                yield {
                    "type": "agent_step",
                    "step": f"Vision Failover: {cfg['name']} failed -> Switching to {next_name}"
                }

    summary = "; ".join(f"{p}: {err}" for p, err in attempt_errors)
    raise LLMServiceError(f"All Vision providers failed: {summary}")


def transcribe_image(image_base64: str, mime_type: str = "image/png") -> str:
    """
    Approach 2 OCR transcription: extracts all text, numerical offers,
    terms, badges, and button labels from a webpage image or ad banner.
    """
    prompt = (
        "You are an OCR and document intelligence engine. Extract and transcribe ALL text, numbers, "
        "rates, discounts, prices, disclaimers, badges, buttons, and brand names found in this image. "
        "If this image is an advertisement, banner, or promotional card, clearly list: "
        "1. Main Headline / Offer (e.g. Invest X and get Y) "
        "2. Features, Badges, or Life Cover details "
        "3. Any visible pricing, percentages, or terms "
        "4. Call-to-action button or link text. "
        "Return ONLY the concise factual transcription formatted in Markdown. Do not include introductory chatter."
    )
    return generate_vision_answer(prompt, image_base64, mime_type=mime_type)
