import { createHash, createHmac } from 'node:crypto'

// AWS Signature Version 4, just enough to call one AWS API with fetch (used
// for Amazon SES), so the app doesn't need the AWS SDK.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

const sha256 = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex')
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data, 'utf8').digest()

// Returns the headers to send: the ones given plus host, x-amz-date (and the
// session token) and Authorization.
export function signAwsRequest(input: {
  method: string
  url: string
  headers: Record<string, string>
  body: string
  region: string
  service: string
  credentials: AwsCredentials
  now?: Date
}): Record<string, string> {
  const url = new URL(input.url)
  const amzDate = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)

  const headers: Record<string, string> = { ...input.headers, host: url.host, 'x-amz-date': amzDate }
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort()
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]))
  const signedHeaders = names.join(';')

  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  const canonicalRequest = [
    input.method,
    url.pathname || '/',
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    signedHeaders,
    sha256(input.body),
  ].join('\n')

  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, date), input.region), input.service), 'aws4_request')
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex')

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
