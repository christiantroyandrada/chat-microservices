import axios, { AxiosInstance } from 'axios'
import config from '../config/config'

/**
 * Safe SendinBlue (Brevo) client using axios directly
 * Replaces the vulnerable sib-api-v3-typescript package
 * API docs: https://developers.brevo.com/reference/sendtransacemail
 */
export class SendinBlueService {
  private client: AxiosInstance

  constructor() {
    if (!config.SENDINBLUE_APIKEY) {
      console.warn('[SendinBlueService] No SENDINBLUE_APIKEY found. Email via SendinBlue will be disabled.')
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
   * @param to - recipient email address
   * @param subject - email subject
   * @param htmlContent - HTML body content
   * @param textContent - optional plain text fallback
   * @returns Promise with messageId or throws error
   */
  async sendTransactionalEmail(
    to: string,
    subject: string,
    htmlContent: string,
    textContent?: string
  ): Promise<{ messageId: string }> {
    if (!config.SENDINBLUE_APIKEY) {
      throw new Error('[SendinBlueService] API key not configured')
    }

    if (!config.EMAIL_FROM) {
      throw new Error('[SendinBlueService] EMAIL_FROM not configured')
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

      console.log('[SendinBlueService] Email sent successfully:', response.data.messageId)
      return { messageId: response.data.messageId }
    } catch (error: any) {
      if (error.response) {
        // API returned an error response
        console.error('[SendinBlueService] API error:', {
          status: error.response.status,
          data: error.response.data
        })
        throw new Error(`SendinBlue API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`)
      } else if (error.request) {
        // Request made but no response received
        console.error('[SendinBlueService] Network error:', error.message)
        throw new Error(`SendinBlue network error: ${error.message}`)
      } else {
        // Something else happened
        console.error('[SendinBlueService] Unexpected error:', error.message)
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
      console.error('[SendinBlueService] Failed to get account info:', error.message)
      throw error
    }
  }
}
