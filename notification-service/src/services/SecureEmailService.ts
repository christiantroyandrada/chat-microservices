import axios, { AxiosInstance } from 'axios'
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer'
import config from '../config/config'
import { logInfo, logWarn, logError } from '../utils/logger'
import type { BrevoEmailPayload, BrevoAccountInfo } from '../types'

type Attachment = { filename: string; contentBase64: string; cid?: string }

export class SecureEmailService {
  private readonly client: AxiosInstance
  private smtpTransport: Transporter | null = null

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

  async sendTransactionalEmail(
    to: string,
    subject: string,
    htmlContent: string,
    textContent?: string,
    attachments?: Attachment[]
  ): Promise<{ messageId: string }> {
    if (!config.EMAIL_FROM) {
      throw new Error('[SecureEmailService] EMAIL_FROM not configured')
    }
    const smtpConfigured = config.smtp?.host && config.smtp.user && config.smtp.pass
    if (!smtpConfigured && !config.SENDINBLUE_APIKEY) {
      throw new Error('[SecureEmailService] API key not configured')
    }

    try {
      if (smtpConfigured) {
        if (!this.smtpTransport) {
          this.smtpTransport = nodemailer.createTransport({
            host: config.smtp.host,
            port: Number(config.smtp.port) || 587,
            secure: Number(config.smtp.port) === 465,
            auth: {
              user: config.smtp.user,
              pass: config.smtp.pass
            },
            disableFileAccess: true,
            disableUrlAccess: true,
            connectionTimeout: 4000,
            greetingTimeout: 4000,
            socketTimeout: 10000,
          })
        }

        const mailOptions: SendMailOptions = {
          from: `Secret <${config.EMAIL_FROM}>`,
          to,
          subject,
          html: htmlContent,
          disableFileAccess: true,
          disableUrlAccess: true,
        }

        if (attachments && attachments.length) {
          mailOptions.attachments = attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), cid: a.cid }))
        }

        const info = await this.smtpTransport.sendMail(mailOptions)
        if (!Array.isArray(info.accepted) || !info.accepted.length) {
          if (info.rejected?.length) throw Object.assign(new Error('Provider rejected recipient'), { code: 'EENVELOPE', responseCode: 550 })
          throw new Error('Provider acceptance missing')
        }
        logInfo('[SecureEmailService] SMTP email sent successfully:', info.messageId || info.response)
        return { messageId: info.messageId || String(info.response || '') }
      }

      const payload: BrevoEmailPayload = {
        sender: {
          email: config.EMAIL_FROM,
          name: 'Secret'
        },
        to: [{ email: to }],
        subject,
        htmlContent,
        ...(textContent && { textContent })
      }

      if (attachments && attachments.length) {
        payload.attachment = attachments.map(a => ({ name: a.filename, content: a.contentBase64 }))
      }

      const response = await this.client.post('/smtp/email', payload)
      if (typeof response.data?.messageId !== 'string' || !response.data.messageId.trim()) throw new Error('Provider acceptance missing')

      logInfo('[SecureEmailService] Email sent successfully:', response.data.messageId)
      return { messageId: response.data.messageId }
    } catch (err: unknown) {
      logError('[SecureEmailService] Email delivery failed')
      throw err
    }
  }

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

  async sendEmail(to: string, subject: string, content: string, attachments?: { filename: string; contentBase64: string; cid?: string }[]) {
    await this.sendTransactionalEmail(to, subject, content, undefined, attachments).catch((err) => {
      logError('[SecureEmailService] sendEmail failed:', err)
      throw err
    })
  }
}
