import React from "react";

const FacebookIcon = ({ size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="16" cy="16" r="16" fill="#1877F2" />
    <path
      d="M21.5 10.5h-3c-.4 0-.5.1-.5.5v2h3.5l-.5 3H18V26h-4V16h-2.5v-3H14v-2.5C14 8.6 15.6 7 17.5 7H21.5v3.5z"
      fill="white"
    />
  </svg>
);

const InstagramIcon = ({ size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <radialGradient
        id="igGrad"
        cx="30%"
        cy="107%"
        r="130%"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0%" stopColor="#fdf497" />
        <stop offset="45%" stopColor="#fd5949" />
        <stop offset="60%" stopColor="#d6249f" />
        <stop offset="90%" stopColor="#285AEB" />
      </radialGradient>
    </defs>
    <rect width="32" height="32" rx="8" fill="url(#igGrad)" />
    <rect
      x="6"
      y="6"
      width="20"
      height="20"
      rx="5.5"
      stroke="white"
      strokeWidth="1.8"
      fill="none"
    />
    <circle
      cx="16"
      cy="16"
      r="5"
      stroke="white"
      strokeWidth="1.8"
      fill="none"
    />
    <circle cx="22" cy="10" r="1.4" fill="white" />
  </svg>
);

const WhatsAppIcon = ({ size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="16" cy="16" r="16" fill="#25D366" />
    <path
      fill="white"
      d="M16 6C10.477 6 6 10.477 6 16c0 1.766.465 3.42 1.28 4.858L6 26l5.28-1.26A9.93 9.93 0 0016 26c5.523 0 10-4.477 10-10S21.523 6 16 6zm4.89 13.75c-.217.61-1.27 1.155-1.74 1.21-.47.055-.91.22-3.067-.64-2.243-.98-4.083-4.04-4.213-4.21-.13-.17-1.077-1.43-1.077-2.73s.68-1.94.92-2.2c.24-.26.52-.325.693-.325l.5.01c.16.006.376.026.573.47l.84 2.03c.065.16.104.347.006.56l-.32.64-.31.53c-.12.2-.254.42-.11.69.146.27.65 1.072 1.397 1.736.96.86 1.77 1.127 2.04 1.255.27.128.426.107.58-.064.156-.17.65-.757.823-1.017.172-.26.344-.217.58-.13l1.84.866c.216.103.36.153.413.237.052.085.052.49-.165 1.1z"
    />
  </svg>
);

// Gmail icon (envelope style)
const GmailIcon = ({ size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 512 512"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M48 100h416v312H48z" fill="#ECEFF1" />
    <path d="M48 100l208 140L464 100H48z" fill="#CFD8DC" />
    <path d="M48 100v312l120-156L48 100z" fill="#F44336" />
    <path d="M464 100v312L344 256l120-156z" fill="#1E88E5" />
    <path d="M48 412l120-156 88 60 88-60 120 156H48z" fill="#E53935" />
    <path d="M256 316l-88-60L48 100h416l-120 156-88 60z" fill="#FFFFFF" />
  </svg>
);

const PlatformIcon = ({ platform, size = 18 }) => {
  switch (platform) {
    case "instagram":
      return <InstagramIcon size={size} />;
    case "facebook":
      return <FacebookIcon size={size} />;
    case "whatsapp":
      return <WhatsAppIcon size={size} />;
    case "email":
      return <GmailIcon size={size} />;
    default:
      return null;
  }
};

export default PlatformIcon;
