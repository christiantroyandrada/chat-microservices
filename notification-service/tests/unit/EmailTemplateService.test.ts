import fs from 'fs'
import path from 'path'

import {
  loadTemplate,
  renderTemplate,
  loadLogoDataUri,
  loadLogoAttachment,
} from '../../src/services/EmailTemplateService'

describe('EmailTemplateService', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('renderTemplate replaces placeholders', () => {
    const tpl = '<div>Hello {{NAME}}, welcome to {{APP}}!</div>'
    const out = renderTemplate(tpl, { NAME: 'Alice', APP: 'Chat' })
    expect(out).toBe('<div>Hello Alice, welcome to Chat!</div>')
  })

  test('loadTemplate returns file contents when candidate exists', () => {
    // Mock fs to simulate a template file present at one of the candidates
    const fakePath = path.join(__dirname, '..', '..', 'src', 'templates', 'fake-template.html')
    jest.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      return String(p).endsWith('fake-template.html')
    })
    jest.spyOn(fs, 'readFileSync').mockImplementation((p: any, enc?: any) => {
      if (String(p).endsWith('fake-template.html')) return '<p>it works</p>'
      throw new Error('unexpected')
    })

    const out = loadTemplate('fake-template.html')
    expect(out).toBe('<p>it works</p>')
  })

  test('loadLogoDataUri prefers .b64 and returns data URI', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      return String(p).endsWith('logo.png.b64')
    })
    jest.spyOn(fs, 'readFileSync').mockImplementation((p: any, enc?: any) => {
      // called with utf8 for .b64 candidate
      if (String(p).endsWith('logo.png.b64')) return 'FAKEBASE64DATA'
      throw new Error('unexpected')
    })

    const uri = loadLogoDataUri()
    expect(uri).toBe('data:image/png;base64,FAKEBASE64DATA')
  })

  test('loadLogoAttachment returns object for .b64 candidate', () => {
    jest.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      return String(p).endsWith('logo.png.b64')
    })
    jest.spyOn(fs, 'readFileSync').mockImplementation((p: any, enc?: any) => {
      if (String(p).endsWith('logo.png.b64')) return 'data:image/png;base64,ABCD1234'
      throw new Error('unexpected')
    })

    const att = loadLogoAttachment()
    expect(att).not.toBeNull()
    expect(att!.filename).toBe('logo.png')
    expect(att!.cid).toBe('logo@chat-app')
    // contentBase64 should have data-uri prefix stripped by implementation
    expect(att!.contentBase64).toBe('ABCD1234')
  })

  test('loadLogoDataUri and loadLogoAttachment handle binary PNG buffer', () => {
    // simulate binary png present (no .b64)
    const fakeBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03])
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      return String(p).endsWith('logo.png')
    })
    jest.spyOn(fs, 'readFileSync').mockImplementation((p: any, enc?: any) => {
      // when reading binary file, the implementation calls without encoding
      if (String(p).endsWith('logo.png')) return fakeBuffer
      throw new Error('unexpected')
    })

    const uri = loadLogoDataUri()
    // should be a data uri with base64 of our buffer
    const expectedBase64 = fakeBuffer.toString('base64')
    expect(uri).toBe(`data:image/png;base64,${expectedBase64}`)

    const att = loadLogoAttachment()
    expect(att).not.toBeNull()
    expect(att!.filename).toBe('logo.png')
    expect(att!.cid).toBe('logo@chat-app')
    expect(att!.contentBase64).toBe(expectedBase64)
  })
})
