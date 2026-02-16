import React from "react";
import { Link } from "react-router-dom";

const PrivacyPolicy = () => {
  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 800 }}>
        <div className="brand">
          <span>Unified Inbox</span>
        </div>
        <h1>Privacy Policy</h1>

        <div style={{ textAlign: "left", marginTop: 20, lineHeight: 1.6 }}>
          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            1. Information We Collect
          </h2>
          <p>
            We collect information you provide directly to us, including your
            name, email address, password, and role when you create an account.
            We also collect information about your use of our services.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            2. How We Use Your Information
          </h2>
          <p>
            We use the information we collect to provide, maintain, and improve
            our services, to communicate with you, to monitor and analyze
            trends, and to personalize your experience.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            3. Information Sharing
          </h2>
          <p>
            We do not share your personal information with third parties except
            as described in this policy. We may share information with service
            providers who assist in operating our platform.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>4. Data Security</h2>
          <p>
            We take reasonable measures to protect your information from
            unauthorized access, use, or disclosure. However, no method of
            transmission over the internet is 100% secure.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>5. Your Rights</h2>
          <p>
            You have the right to access, update, or delete your personal
            information at any time. You can do this by logging into your
            account or contacting us directly.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            6. Cookies and Tracking
          </h2>
          <p>
            We use local storage to maintain your login session. We do not use
            third-party tracking cookies or analytics at this time.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            7. Changes to This Policy
          </h2>
          <p>
            We may update this privacy policy from time to time. We will notify
            you of any changes by posting the new policy on this page.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>8. Contact Us</h2>
          <p>
            If you have any questions about this Privacy Policy, please contact
            us at privacy@unifiedinbox.com
          </p>

          <p style={{ marginTop: 30, fontSize: 12, color: "#666" }}>
            Last updated: February 16, 2026
          </p>
        </div>

        <div style={{ marginTop: 30 }}>
          <Link
            to="/login"
            className="btn-primary"
            style={{ display: "inline-block", textDecoration: "none" }}
          >
            Back to Login
          </Link>
        </div>
      </div>
    </div>
  );
};

export default PrivacyPolicy;
