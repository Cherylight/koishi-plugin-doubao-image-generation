export type ImageGenerationErrorCategory =
  | 'upstream_quota_exhausted'
  | 'content_policy_violation'
  | 'rate_limited'
  | 'authentication_failed'
  | 'invalid_request'
  | 'upstream_unavailable'
  | 'unknown'

export interface ImageGenerationErrorClassification {
  category: ImageGenerationErrorCategory
  retryable: boolean
  suggestedAction: string
}

export interface ImageGenerationErrorLike {
  code?: string
  type?: string
  message?: string
  httpStatus?: number
}

const TOOL_RESULT_PROTOCOL = [
  'Execution and delivery protocol: this call waits until image generation finishes and, on success, until the generated images have been sent to the user.',
  'Do not say that the image is still being generated, and do not send the accompanying final reply before reading the tool result.',
  'A success result means the images were already delivered; then continue with the matching in-character text.',
  'A failure result is visible only to you and no plugin error notice was sent to the user. Handle it naturally according to error.category, retryable, and suggestedAction.',
  'For content_policy_violation, safely revise the prompt and retry at most once. For rate_limited or upstream_unavailable, retry at most once only when retryable is true.',
  'For upstream_quota_exhausted, plugin_quota_exhausted, duplicate_request, or delivery_failed, do not repeat the same request in the current turn.',
].join(' ')

export function buildChatlunaToolDescription(baseDescription: string): string {
  const base = String(baseDescription || '').trim()
  return base ? `${base}\n\n${TOOL_RESULT_PROTOCOL}` : TOOL_RESULT_PROTOCOL
}

export function classifyImageGenerationError(
  error: ImageGenerationErrorLike,
): ImageGenerationErrorClassification {
  const code = String(error.code || '').toLowerCase()
  const type = String(error.type || '').toLowerCase()
  const message = String(error.message || '').toLowerCase()
  const combined = `${code} ${type} ${message}`

  if (
    combined.includes('insufficient_quota')
    || combined.includes('no available image quota')
    || combined.includes('quota exhausted')
    || combined.includes('billing hard limit')
  ) {
    return {
      category: 'upstream_quota_exhausted',
      retryable: false,
      suggestedAction: 'Do not retry the same request in this turn. Continue naturally without the image and briefly say the image service is temporarily unavailable if needed.',
    }
  }

  if (
    combined.includes('riskdetection')
    || combined.includes('sensitivecontent')
    || combined.includes('content_policy')
    || combined.includes('content policy')
    || combined.includes('content_filter')
    || combined.includes('moderation')
    || combined.includes('safety violation')
  ) {
    return {
      category: 'content_policy_violation',
      retryable: true,
      suggestedAction: 'If the user intent is safe, remove or rephrase the sensitive details and retry once. If it still fails, stop retrying and respond naturally without exposing raw provider errors.',
    }
  }

  if (
    combined.includes('ratelimit')
    || combined.includes('rate_limit')
    || combined.includes('rate limit')
    || combined.includes('too many requests')
    || combined.includes('requestbursttoofast')
    || error.httpStatus === 429
  ) {
    return {
      category: 'rate_limited',
      retryable: true,
      suggestedAction: 'Do not retry repeatedly. Retry at most once after a delay when appropriate; otherwise continue naturally and suggest trying again later.',
    }
  }

  if (
    combined.includes('authentication')
    || combined.includes('unauthorized')
    || combined.includes('invalid api key')
    || error.httpStatus === 401
    || error.httpStatus === 403
  ) {
    return {
      category: 'authentication_failed',
      retryable: false,
      suggestedAction: 'Do not retry. Continue naturally without the image; an administrator must check the image service credentials or permissions.',
    }
  }

  if (
    combined.includes('invalidparameter')
    || combined.includes('missingparameter')
    || combined.includes('invalidargument')
    || combined.includes('invalid_request')
    || error.httpStatus === 400
    || error.httpStatus === 422
  ) {
    return {
      category: 'invalid_request',
      retryable: true,
      suggestedAction: 'Correct the prompt or request parameters and retry once. Do not repeat the unchanged request.',
    }
  }

  if (
    combined.includes('internalserviceerror')
    || combined.includes('serveroverloaded')
    || combined.includes('timeout')
    || combined.includes('timedout')
    || combined.includes('network')
    || combined.includes('econnreset')
    || combined.includes('econnrefused')
    || (typeof error.httpStatus === 'number' && error.httpStatus >= 500)
  ) {
    return {
      category: 'upstream_unavailable',
      retryable: true,
      suggestedAction: 'Retry at most once. If it still fails, continue naturally without the image and suggest trying again later.',
    }
  }

  return {
    category: 'unknown',
    retryable: false,
    suggestedAction: 'Do not blindly retry. Continue naturally without the image and avoid exposing raw provider errors to the user.',
  }
}
