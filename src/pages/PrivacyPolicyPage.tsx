import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm'

const PrivacyPolicy =
`
# Privacy Policy
**Effective Date:** 28.04.2025

## Welcome to Tangent Cash Giveaway (https://try.tangent.cash)

We are committed to protecting your privacy and ensuring the security of any information you provide while using our website. This Privacy Policy explains how we handle the personal information we collect through our giveaway platform.

## 1. Information Collection and Use

### 1.1 Types of Data Collected

We collect the following types of information when users participate in giveaways:

| Data Type | Purpose | Storage |
|-----------|---------|---------|
| **Tangent Wallet Address** | To verify participation and determine winners | Stored in database, hashed for public display |
| **X (Twitter) Username** | To verify social media participation requirements | Stored in database |
| **Discord Username** | To verify Discord participation (when mandatory or for rewards) | Stored in database |

### 1.2 Data We Do Not Collect

We do not collect or store:
- Physical addresses
- Phone numbers
- Payment information (other than wallet addresses)
- Biometric data
- Sensitive personal information

## 2. Data Usage

Your information is used exclusively for:
- Verifying eligibility for giveaways
- Determining winners through our blockchain-based selection process
- Communicating winner announcements
- Ensuring compliance with giveaway rules

## 3. Data Security

### 3.1 Storage Security

- All participant data is stored in a database on our secure servers
- Wallet addresses are hashed using SHA-256 for public winner displays
- The hash combines the giveaway ID with the wallet address for unique, non-reversible identification

### 3.2 Blockchain Verification

- Winner selection is based on blockchain block proofs from the Tangent network
- The selection process is deterministic and verifiable
- Once a giveaway is finished, winner data can be independently verified using the block proof

## 4. Data Retention

- Participant data is retained for the duration of the giveaway period
- After a giveaway is completed, data may be retained for:
  - Dispute resolution
  - Regulatory compliance
  - Audit purposes
- You may request data deletion by contacting us (see Section 7)

## 5. Third-Party Services

We do not use third-party analytics, advertising, or tracking services that collect user data without explicit consent.

## 6. User Rights

### 6.1 Access and Correction

You have the right to:
- Request access to your personal data
- Request correction of inaccurate data
- Request deletion of your data

### 6.2 How to Exercise Your Rights

To exercise your rights, please contact us at:
- **Email:** devs@tangent.cash

We will respond to your request within 30 days.

### 6.3 Limitations

- Once a giveaway is finished and winners determined, we may retain data for dispute resolution purposes
- Hashed wallet addresses cannot be reversed to reveal original addresses

## 7. Children's Privacy

Our services are not intended for users under the age of 18. We do not knowingly collect personal information from children. If you become aware that a child has provided us with personal information, please contact us immediately.

## 8. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. Any changes will be:
- Posted on this page with an updated effective date
- Available at https://try.tangent.cash

We encourage you to review this Privacy Policy periodically to stay informed about how we are protecting your privacy.

## 9. Governing Law

This Privacy Policy is governed by the laws of the jurisdiction in which Tangent Cash operates, without regard to its conflict of law provisions.

## 10. Contact Information

If you have any questions or concerns about this Privacy Policy, please contact us at:

- **Email:** devs@tangent.cash
- **Website:** https://try.tangent.cash

---

**By using Tangent Cash Giveaway (https://try.tangent.cash), you acknowledge that you have read and understood this Privacy Policy and agree to its terms. Thank you for choosing our platform!**
`;

function PrivacyPolicyPage() {
  return (
    <div className="container">
      <header className="header">
        <h1>Legal documents</h1>
      </header>
      <main>
        <div className="prose">
          <Markdown remarkPlugins={[remarkGfm]}>{PrivacyPolicy}</Markdown>
        </div>
      </main>
    </div>
  );
}

export default PrivacyPolicyPage;