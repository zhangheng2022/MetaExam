import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Ephemeral test identity only: no certificate store, root trust, or persistent key container. */
export async function temporaryTls(directory) {
  const result = JSON.parse(
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
    $ErrorActionPreference='Stop'
    $rsa=[Security.Cryptography.RSACng]::new(2048)
    try {
      $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=MetaExam temporary upgrade test',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
      $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
      $san.AddDnsName('localhost')
      $request.CertificateExtensions.Add($san.Build())
      $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(2))
      $p=$rsa.ExportParameters($true)
      function Enc($v) { [Convert]::ToBase64String($v).TrimEnd('=').Replace('+','-').Replace('/','_') }
      @{ cert=[Convert]::ToBase64String($cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)); key=@{kty='RSA'; n=(Enc $p.Modulus); e=(Enc $p.Exponent); d=(Enc $p.D); p=(Enc $p.P); q=(Enc $p.Q); dp=(Enc $p.DP); dq=(Enc $p.DQ); qi=(Enc $p.InverseQ)} } | ConvertTo-Json -Compress
      $cert.Dispose()
    } finally { $rsa.Dispose() }
  `,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 },
    ),
  );
  const cert =
    '-----BEGIN CERTIFICATE-----\n' +
    result.cert.match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----\n';
  const key = createPrivateKey({ key: result.key, format: 'jwk' }).export({
    type: 'pkcs8',
    format: 'pem',
  });
  const tlsCert = path.join(directory, 'temporary.crt'),
    tlsKey = path.join(directory, 'temporary.key');
  await writeFile(tlsCert, cert, { flag: 'wx' });
  await writeFile(tlsKey, key, { flag: 'wx' });
  return { tlsCert, tlsKey, ca: cert };
}
