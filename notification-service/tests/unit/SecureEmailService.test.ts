const httpClient = {
  get: jest.fn(),
  post: jest.fn(),
}

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
    isAxiosError: jest.fn(),
  },
}))

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: jest.fn(),
  },
}))

jest.mock('../../src/config/config', () => ({
  __esModule: true,
  default: {
    EMAIL_FROM: 'noreply@chat.example',
    SENDINBLUE_APIKEY: 'brevo-key',
    smtp: {
      host: undefined,
      pass: undefined,
      port: 587,
      user: undefined,
    },
  },
}))

jest.mock('../../src/utils/logger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}))

type EmailConfig = {
  EMAIL_FROM?: string
  SENDINBLUE_APIKEY?: string
  smtp: {
    host?: string
    pass?: string
    port?: number | string
    user?: string
  }
}

type AxiosBoundary = {
  create: jest.Mock
  isAxiosError: jest.Mock
}

type NodemailerBoundary = {
  createTransport: jest.Mock
}

function axiosBoundary(): AxiosBoundary {
  return (jest.requireMock('axios') as { default: AxiosBoundary }).default
}

function nodemailerBoundary(): NodemailerBoundary {
  return (jest.requireMock('nodemailer') as { default: NodemailerBoundary }).default
}

function emailConfig(): EmailConfig {
  return (jest.requireMock('../../src/config/config') as { default: EmailConfig }).default
}

function loadService(): typeof import('../../src/services/SecureEmailService') {
  return require('../../src/services/SecureEmailService') as typeof import('../../src/services/SecureEmailService')
}

describe('SecureEmailService', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    httpClient.get.mockReset()
    httpClient.post.mockReset()
    axiosBoundary().create.mockReturnValue(httpClient)
    emailConfig().SENDINBLUE_APIKEY = 'brevo-key'
    emailConfig().EMAIL_FROM = 'noreply@chat.example'
    emailConfig().smtp = { host: undefined, pass: undefined, port: 587, user: undefined }
  })

  afterEach(() => {
    jest.resetModules()
  })

  test('rejects without an API key before SMTP or Brevo delivery', async () => {
    emailConfig().SENDINBLUE_APIKEY = undefined
    const transport = { sendMail: jest.fn() }
    nodemailerBoundary().createTransport.mockReturnValue(transport)
    const service = new (loadService().SecureEmailService)()

    await expect(service.sendTransactionalEmail('person@example.com', 'Subject', '<p>Body</p>'))
      .rejects.toThrow('[SecureEmailService] API key not configured')

    expect(nodemailerBoundary().createTransport).not.toHaveBeenCalled()
    expect(transport.sendMail).not.toHaveBeenCalled()
    expect(httpClient.post).not.toHaveBeenCalled()
  })

  test('rejects without a sender before SMTP or Brevo delivery', async () => {
    emailConfig().EMAIL_FROM = undefined
    const transport = { sendMail: jest.fn() }
    nodemailerBoundary().createTransport.mockReturnValue(transport)
    const service = new (loadService().SecureEmailService)()

    await expect(service.sendTransactionalEmail('person@example.com', 'Subject', '<p>Body</p>'))
      .rejects.toThrow('[SecureEmailService] EMAIL_FROM not configured')

    expect(nodemailerBoundary().createTransport).not.toHaveBeenCalled()
    expect(transport.sendMail).not.toHaveBeenCalled()
    expect(httpClient.post).not.toHaveBeenCalled()
  })

  test('creates one secure SMTP transport and sends buffered CID attachments', async () => {
    emailConfig().smtp = { host: 'smtp.chat.example', pass: 'smtp-pass', port: '465', user: 'smtp-user' }
    const transport = {
      sendMail: jest.fn().mockResolvedValue({ messageId: '', response: '250 queued' }),
    }
    nodemailerBoundary().createTransport.mockReturnValue(transport)
    const service = new (loadService().SecureEmailService)()

    await expect(service.sendTransactionalEmail(
      'person@example.com',
      'Welcome',
      '<p>Welcome</p>',
      'Welcome',
      [{ filename: 'logo.png', contentBase64: 'AQID', cid: 'logo@chat-app' }],
    )).resolves.toEqual({ messageId: '250 queued' })
    await expect(service.sendTransactionalEmail('person@example.com', 'Follow up', '<p>Next</p>'))
      .resolves.toEqual({ messageId: '250 queued' })

    expect(nodemailerBoundary().createTransport).toHaveBeenCalledTimes(1)
    expect(nodemailerBoundary().createTransport).toHaveBeenCalledWith({
      host: 'smtp.chat.example',
      port: 465,
      secure: true,
      auth: { user: 'smtp-user', pass: 'smtp-pass' },
      disableFileAccess: true,
      disableUrlAccess: true,
    })
    expect(transport.sendMail).toHaveBeenNthCalledWith(1, {
      from: 'Chat Service <noreply@chat.example>',
      to: 'person@example.com',
      subject: 'Welcome',
      html: '<p>Welcome</p>',
      disableFileAccess: true,
      disableUrlAccess: true,
      attachments: [{ filename: 'logo.png', content: Buffer.from('AQID', 'base64'), cid: 'logo@chat-app' }],
    })
  })

  test('defaults SMTP to numeric port 587 and disables TLS-only port security elsewhere', async () => {
    emailConfig().smtp = { host: 'smtp.chat.example', pass: 'smtp-pass', port: 0, user: 'smtp-user' }
    const transport = { sendMail: jest.fn().mockResolvedValue({ messageId: 'smtp-message-2' }) }
    nodemailerBoundary().createTransport.mockReturnValue(transport)
    const service = new (loadService().SecureEmailService)()

    await expect(service.sendTransactionalEmail('person@example.com', 'Subject', '<p>Body</p>'))
      .resolves.toEqual({ messageId: 'smtp-message-2' })

    expect(nodemailerBoundary().createTransport).toHaveBeenCalledWith({
      host: 'smtp.chat.example',
      port: 587,
      secure: false,
      auth: { user: 'smtp-user', pass: 'smtp-pass' },
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  })

  test('uses the Brevo payload including text and attachment objects when SMTP is incomplete', async () => {
    httpClient.post.mockResolvedValue({ data: { messageId: 'brevo-message-1' } })
    const service = new (loadService().SecureEmailService)()

    await expect(service.sendTransactionalEmail(
      'person@example.com',
      'Welcome',
      '<p>Welcome</p>',
      'Welcome',
      [{ filename: 'logo.png', contentBase64: 'AQID', cid: 'ignored-by-brevo' }],
    )).resolves.toEqual({ messageId: 'brevo-message-1' })

    expect(httpClient.post).toHaveBeenCalledWith('/smtp/email', {
      sender: { email: 'noreply@chat.example', name: 'Chat Service' },
      to: [{ email: 'person@example.com' }],
      subject: 'Welcome',
      htmlContent: '<p>Welcome</p>',
      textContent: 'Welcome',
      attachment: [{ name: 'logo.png', content: 'AQID' }],
    })
  })

  test('preserves Brevo response, request, and non-Axios errors', async () => {
    const service = new (loadService().SecureEmailService)()
    axiosBoundary().isAxiosError.mockReturnValue(true)
    httpClient.post.mockRejectedValueOnce({ response: { status: 401, data: { code: 'invalid-key' } } })
    httpClient.post.mockRejectedValueOnce({ request: {}, message: 'socket closed' })
    const unexpected = new Error('unexpected failure')
    httpClient.post.mockRejectedValueOnce(unexpected)

    await expect(service.sendTransactionalEmail('person@example.com', 'Subject', '<p>Body</p>'))
      .rejects.toThrow('SendinBlue API error: 401 - {"code":"invalid-key"}')
    await expect(service.sendTransactionalEmail('person@example.com', 'Subject', '<p>Body</p>'))
      .rejects.toThrow('SendinBlue network error: socket closed')
    axiosBoundary().isAxiosError.mockReturnValue(false)
    await expect(service.sendTransactionalEmail('person@example.com', 'Subject', '<p>Body</p>'))
      .rejects.toBe(unexpected)
  })

  test('keeps account lookup and compatibility wrapper behavior', async () => {
    httpClient.get.mockResolvedValue({ data: { email: 'owner@chat.example', firstName: 'Owner' } })
    const service = new (loadService().SecureEmailService)()

    await expect(service.getAccount()).resolves.toEqual({ email: 'owner@chat.example', firstName: 'Owner' })
    const failure = new Error('Brevo unavailable')
    httpClient.post.mockRejectedValue(failure)
    axiosBoundary().isAxiosError.mockReturnValue(false)

    await expect(service.sendEmail('person@example.com', 'Subject', '<p>Body</p>')).rejects.toBe(failure)
  })
})
