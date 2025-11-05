import axios, { AxiosInstance } from 'axios'
import config from '../config/config'

/**
 * SecureEmailService — a thin, secure wrapper around the Brevo (SendinBlue)
 * HTTP API using axios. This replaces the previous vulnerable
 * sib-api-v3-typescript dependency and provides a compatible
 * sendEmail(...) method so existing callers don't need immediate changes.
 */
export class SecureEmailService {
  private client: AxiosInstance

  constructor() {
    if (!config.SENDINBLUE_APIKEY) {
      console.warn('[SecureEmailService] No SENDINBLUE_APIKEY found. Email via SendinBlue will be disabled.')
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
      const payload = {
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

      console.log('[SecureEmailService] Email sent successfully:', response.data.messageId)
      return { messageId: response.data.messageId }
    } catch (error: any) {
      if (error.response) {
        // API returned an error response
        console.error('[SecureEmailService] API error:', {
          status: error.response.status,
          data: error.response.data
        })
        throw new Error(`SendinBlue API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`)
      } else if (error.request) {
        // Request made but no response received
        console.error('[SecureEmailService] Network error:', error.message)
        throw new Error(`SendinBlue network error: ${error.message}`)
      } else {
        // Something else happened
        console.error('[SecureEmailService] Unexpected error:', error.message)
        throw error
      }
    }
  }

  /**
   * Check account info to verify API key is valid
   */
  async getAccount(): Promise<any> {
    try {
      const response = await this.client.get('/account')
      return response.data
    } catch (error: any) {
      console.error('[SecureEmailService] Failed to get account info:', error.message)
      throw error
    }
  }

  /**
   * Compatibility wrapper for the legacy EmailService.sendEmail signature
   */
  async sendEmail(to: string, subject: string, content: string) {
    await this.sendTransactionalEmail(to, subject, content).catch((err) => {
      console.error('[SecureEmailService] sendEmail failed:', err)
      throw err
    })
  }
}
