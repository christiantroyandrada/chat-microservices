import axios, { AxiosInstance } from 'axios'
import config from '../config/config'
import { logInfo, logWarn, logError } from '../utils/logger'
import type { BrevoEmailPayload, BrevoAccountInfo, AxiosErrorResponse } from '../types'

/**
 * SecureEmailService — a thin, secure wrapper around the Brevo (SendinBlue)
 * HTTP API using axios. This replaces the previous vulnerable
 * sib-api-v3-typescript dependency and provides a compatible
 * sendEmail(...) method so existing callers don't need immediate changes.
 */
export class SecureEmailService {
  private readonly client: AxiosInstance

  constructor() {
    if (!config.SENDINBLUE_APIKEY) {
      logWarn('[SecureEmailService] No SENDINBLUE_APIKEY found. Email via SendinBlue will be disabled.')
    }

    this.client = axios.create({
      baseURL: 'https://api.brevo.com/v3',
      timeout: 10000,
      headers: {
        'api-key': config.SENDINBLUE_APIKEY || '',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    })
  }

  /**
   * Send a transactional email via SendinBlue/Brevo
   */
  async sendTransactionalEmail(
    to: string,
    subject: string,
    htmlContent: string,
    textContent?: string
  ): Promise<{ messageId: string }> {
    if (!config.SENDINBLUE_APIKEY) {
      throw new Error('[SecureEmailService] API key not configured')
    }

    if (!config.EMAIL_FROM) {
      throw new Error('[SecureEmailService] EMAIL_FROM not configured')
    }

    try {
      const payload: BrevoEmailPayload = {
        sender: {
          email: config.EMAIL_FROM,
          name: 'Chat Service'
        },
        to: [{ email: to }],
        subject,
        htmlContent,
        ...(textContent && { textContent })
      }

      const response = await this.client.post('/smtp/email', payload)

  logInfo('[SecureEmailService] Email sent successfully:', response.data.messageId)
      return { messageId: response.data.messageId }
    } catch (err: unknown) {
      // Use axios helper type guard when available
      if (axios.isAxiosError(err)) {
        if (err.response) {
          // API returned an error response
          const errorResponse = err.response as AxiosErrorResponse
          logError('[SecureEmailService] API error:', {
            status: errorResponse.status,
            data: errorResponse.data
          })
          throw new Error(`SendinBlue API error: ${errorResponse.status} - ${JSON.stringify(errorResponse.data)}`)
        } else if (err.request) {
          // Request made but no response received
          logError('[SecureEmailService] Network error:', err.message)
          throw new Error(`SendinBlue network error: ${err.message}`)
        }
      }
      // Fallback for non-axios errors
  logError('[SecureEmailService] Unexpected error:', err)
      throw err
    }
  }

  /**
   * Check account info to verify API key is valid
   */
  async getAccount(): Promise<BrevoAccountInfo> {
    try {
      const response = await this.client.get('/account')
      return response.data as BrevoAccountInfo
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        logError('[SecureEmailService] Failed to get account info:', err.message)
      } else {
        logError('[SecureEmailService] Failed to get account info:', err)
      }
      throw err
    }
  }

  /**
   * Compatibility wrapper for the legacy EmailService.sendEmail signature
   */
  async sendEmail(to: string, subject: string, content: string) {
    await this.sendTransactionalEmail(to, subject, content).catch((err) => {
      logError('[SecureEmailService] sendEmail failed:', err)
      throw err
    })
  }
}
