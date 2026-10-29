USE [master]
GO
/****** Objet : Database [UnifiedBox1] Date de script : 05/10/2026 10:31:07 AM ******/
CREATE DATABASE [UnifiedBox1]
 CONTAINMENT = NONE
 ON  PRIMARY 
( NAME = N'UnifiedBox1', FILENAME = N'C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\DATA\UnifiedBox1.mdf' , SIZE = 73728KB , MAXSIZE = UNLIMITED, FILEGROWTH = 65536KB )
 LOG ON 
( NAME = N'UnifiedBox1_log', FILENAME = N'C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\DATA\UnifiedBox1_log.ldf' , SIZE = 73728KB , MAXSIZE = 2048GB , FILEGROWTH = 65536KB )
 WITH CATALOG_COLLATION = DATABASE_DEFAULT, LEDGER = OFF
GO
ALTER DATABASE [UnifiedBox1] SET COMPATIBILITY_LEVEL = 170
GO
IF (1 = FULLTEXTSERVICEPROPERTY('IsFullTextInstalled'))
begin
EXEC [UnifiedBox1].[dbo].[sp_fulltext_database] @action = 'enable'
end
GO
ALTER DATABASE [UnifiedBox1] SET ANSI_NULL_DEFAULT OFF 
GO
ALTER DATABASE [UnifiedBox1] SET ANSI_NULLS OFF 
GO
ALTER DATABASE [UnifiedBox1] SET ANSI_PADDING OFF 
GO
ALTER DATABASE [UnifiedBox1] SET ANSI_WARNINGS OFF 
GO
ALTER DATABASE [UnifiedBox1] SET ARITHABORT OFF 
GO
ALTER DATABASE [UnifiedBox1] SET AUTO_CLOSE OFF 
GO
ALTER DATABASE [UnifiedBox1] SET AUTO_SHRINK OFF 
GO
ALTER DATABASE [UnifiedBox1] SET AUTO_UPDATE_STATISTICS ON 
GO
ALTER DATABASE [UnifiedBox1] SET CURSOR_CLOSE_ON_COMMIT OFF 
GO
ALTER DATABASE [UnifiedBox1] SET CURSOR_DEFAULT  GLOBAL 
GO
ALTER DATABASE [UnifiedBox1] SET CONCAT_NULL_YIELDS_NULL OFF 
GO
ALTER DATABASE [UnifiedBox1] SET NUMERIC_ROUNDABORT OFF 
GO
ALTER DATABASE [UnifiedBox1] SET QUOTED_IDENTIFIER OFF 
GO
ALTER DATABASE [UnifiedBox1] SET RECURSIVE_TRIGGERS OFF 
GO
ALTER DATABASE [UnifiedBox1] SET  DISABLE_BROKER 
GO
ALTER DATABASE [UnifiedBox1] SET AUTO_UPDATE_STATISTICS_ASYNC OFF 
GO
ALTER DATABASE [UnifiedBox1] SET DATE_CORRELATION_OPTIMIZATION OFF 
GO
ALTER DATABASE [UnifiedBox1] SET TRUSTWORTHY OFF 
GO
ALTER DATABASE [UnifiedBox1] SET ALLOW_SNAPSHOT_ISOLATION OFF 
GO
ALTER DATABASE [UnifiedBox1] SET PARAMETERIZATION SIMPLE 
GO
ALTER DATABASE [UnifiedBox1] SET READ_COMMITTED_SNAPSHOT OFF 
GO
ALTER DATABASE [UnifiedBox1] SET HONOR_BROKER_PRIORITY OFF 
GO
ALTER DATABASE [UnifiedBox1] SET RECOVERY SIMPLE 
GO
ALTER DATABASE [UnifiedBox1] SET  MULTI_USER 
GO
ALTER DATABASE [UnifiedBox1] SET PAGE_VERIFY CHECKSUM  
GO
ALTER DATABASE [UnifiedBox1] SET DB_CHAINING OFF 
GO
ALTER DATABASE [UnifiedBox1] SET FILESTREAM( NON_TRANSACTED_ACCESS = OFF ) 
GO
ALTER DATABASE [UnifiedBox1] SET TARGET_RECOVERY_TIME = 60 SECONDS 
GO
ALTER DATABASE [UnifiedBox1] SET DELAYED_DURABILITY = DISABLED 
GO
ALTER DATABASE [UnifiedBox1] SET OPTIMIZED_LOCKING = OFF 
GO
ALTER DATABASE [UnifiedBox1] SET ACCELERATED_DATABASE_RECOVERY = OFF  
GO
ALTER DATABASE [UnifiedBox1] SET QUERY_STORE = ON
GO
ALTER DATABASE [UnifiedBox1] SET QUERY_STORE (OPERATION_MODE = READ_WRITE, CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = 30), DATA_FLUSH_INTERVAL_SECONDS = 900, INTERVAL_LENGTH_MINUTES = 60, MAX_STORAGE_SIZE_MB = 1000, QUERY_CAPTURE_MODE = AUTO, SIZE_BASED_CLEANUP_MODE = AUTO, MAX_PLANS_PER_QUERY = 200, WAIT_STATS_CAPTURE_MODE = ON)
GO
USE [UnifiedBox1]
GO
/****** Objet : Schema [stg] Date de script : 05/10/2026 10:31:07 AM ******/
CREATE SCHEMA [stg]
GO
/****** Objet : UserDefinedFunction [dbo].[fn_DateTimeCombine] Date de script : 05/10/2026 10:31:07 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE   FUNCTION [dbo].[fn_DateTimeCombine](@d DATE, @t TIME(0))
RETURNS DATETIME2(0)
AS
BEGIN
    RETURN CASE WHEN @d IS NULL THEN NULL
                ELSE DATEADD(SECOND, DATEDIFF(SECOND, 0, ISNULL(@t,'00:00:00')), CAST(@d AS DATETIME2(0)))
           END
END
GO
/****** Objet : Table [dbo].[channels] Date de script : 05/10/2026 10:31:07 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[channels](
	[channel_id] [int] IDENTITY(1,1) NOT NULL,
	[platform] [nvarchar](20) NOT NULL,
	[name] [nvarchar](255) NOT NULL,
	[external_id] [nvarchar](255) NOT NULL,
	[avatar] [nvarchar](500) NULL,
	[is_active] [bit] NOT NULL,
	[is_verified] [bit] NOT NULL,
	[auto_reply] [bit] NOT NULL,
	[auto_reply_message] [nvarchar](max) NULL,
	[created_date] [date] NOT NULL,
	[created_time] [time](0) NOT NULL,
	[updated_date] [date] NOT NULL,
	[updated_time] [time](0) NOT NULL,
 CONSTRAINT [PK_channels] PRIMARY KEY CLUSTERED 
(
	[channel_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_channels_platform_external] UNIQUE NONCLUSTERED 
(
	[platform] ASC,
	[external_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Table [dbo].[stg_call_log] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[stg_call_log](
	[call_date_raw] [nvarchar](30) NULL,
	[source_raw] [nvarchar](50) NULL,
	[ring_group_raw] [nvarchar](50) NULL,
	[destination_raw] [nvarchar](50) NULL,
	[src_channel_raw] [nvarchar](100) NULL,
	[cost_center_raw] [nvarchar](50) NULL,
	[dst_channel_raw] [nvarchar](100) NULL,
	[status_raw] [nvarchar](30) NULL,
	[duration_raw] [nvarchar](50) NULL,
	[loaded_date] [date] NOT NULL,
	[loaded_time] [time](0) NOT NULL
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[channel_call_config] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[channel_call_config](
	[channel_id] [int] NOT NULL,
	[extension_number] [nvarchar](20) NOT NULL,
	[ring_group] [nvarchar](50) NULL,
	[trunk_name] [nvarchar](100) NULL,
	[direction_type] [nvarchar](10) NOT NULL,
	[default_agent_user_id] [int] NULL,
	[is_active] [bit] NOT NULL,
	[created_date] [date] NOT NULL,
	[created_time] [time](0) NOT NULL,
	[updated_date] [date] NOT NULL,
	[updated_time] [time](0) NOT NULL,
 CONSTRAINT [PK_channel_call_config] PRIMARY KEY CLUSTERED 
(
	[channel_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[channel_agents] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[channel_agents](
	[channel_id] [int] NOT NULL,
	[user_id] [int] NOT NULL,
 CONSTRAINT [PK_channel_agents] PRIMARY KEY CLUSTERED 
(
	[channel_id] ASC,
	[user_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[extension_agents] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[extension_agents](
	[extension_agent_id] [int] IDENTITY(1,1) NOT NULL,
	[extension_number] [nvarchar](20) NOT NULL,
	[user_id] [int] NOT NULL,
	[valid_from_date] [date] NOT NULL,
	[valid_from_time] [time](0) NOT NULL,
	[valid_to_date] [date] NULL,
	[valid_to_time] [time](0) NULL,
 CONSTRAINT [PK_extension_agents] PRIMARY KEY CLUSTERED 
(
	[extension_agent_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : View [dbo].[vw_stg_call_log_clean] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/* ---- FIX 6 : direction of unanswered internal calls ---- */
CREATE   VIEW [dbo].[vw_stg_call_log_clean] AS
WITH s AS (
    SELECT
        call_datetime      = TRY_CONVERT(datetime2(0), LTRIM(RTRIM(call_date_raw)), 120),
        source_number      = LTRIM(RTRIM(source_raw)),
        ring_group         = NULLIF(LTRIM(RTRIM(ring_group_raw)), ''),
        destination_number = LTRIM(RTRIM(destination_raw)),
        src_channel_ref    = LTRIM(RTRIM(src_channel_raw)),
        dst_channel_ref    = NULLIF(LTRIM(RTRIM(dst_channel_raw)), ''),
        cost_center        = NULLIF(LTRIM(RTRIM(cost_center_raw)), ''),
        call_status        = UPPER(LTRIM(RTRIM(status_raw))),
        duration_seconds   = TRY_CONVERT(int, LEFT(duration_raw, CHARINDEX('s', duration_raw + 's') - 1)),
        src_peer           = CASE WHEN LTRIM(RTRIM(src_channel_raw)) LIKE 'SIP/%-%'
                                  THEN SUBSTRING(LTRIM(RTRIM(src_channel_raw)), 5,
                                       CHARINDEX('-', LTRIM(RTRIM(src_channel_raw)), 5) - 5) END
    FROM dbo.stg_call_log
),
d AS (
    SELECT s.*,
           direction = CASE
               WHEN s.src_peer <> '' AND s.src_peer NOT LIKE '%[^0-9]%' THEN
                    CASE WHEN s.dst_channel_ref LIKE 'SIP/[0-9]%-%'
                           -- nobody picked up: internal if the number dialled is one of our extensions
                           OR EXISTS (SELECT 1 FROM dbo.extension_agents x
                                      WHERE x.extension_number = s.destination_number)
                           OR EXISTS (SELECT 1 FROM dbo.channel_call_config x
                                      WHERE x.extension_number = s.destination_number)
                         THEN 'internal' ELSE 'outbound' END
               ELSE 'inbound' END
    FROM s
),
e AS (
    SELECT d.*,
           channel_ext = CASE WHEN d.direction = 'inbound'
                              THEN d.destination_number ELSE d.source_number END
    FROM d
)
SELECT
    e.*,
    channel_id = COALESCE(
        cfg.channel_id,
        ag.channel_id,
        (SELECT channel_id FROM dbo.channels
         WHERE platform = 'call' AND external_id = 'UNASSIGNED')),
    channel_resolution = CASE WHEN cfg.channel_id IS NOT NULL THEN 'config'
                              WHEN ag.channel_id  IS NOT NULL THEN 'agent'
                              ELSE 'fallback' END
FROM e
LEFT JOIN dbo.channel_call_config cfg
       ON cfg.extension_number = e.channel_ext
OUTER APPLY (
    SELECT TOP 1 ca.channel_id
    FROM dbo.extension_agents ea
    JOIN dbo.channel_agents ca ON ca.user_id = ea.user_id
    JOIN dbo.channels ch       ON ch.channel_id = ca.channel_id AND ch.platform = 'call'
    WHERE ea.extension_number = e.channel_ext
      AND dbo.fn_DateTimeCombine(ea.valid_from_date, ea.valid_from_time) <= e.call_datetime
      AND (ea.valid_to_date IS NULL OR dbo.fn_DateTimeCombine(ea.valid_to_date, ea.valid_to_time) > e.call_datetime)
    ORDER BY ca.channel_id
) ag;
GO
/****** Objet : Table [dbo].[agent_label_map] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[agent_label_map](
	[agent_label] [nvarchar](100) NOT NULL,
	[user_id] [int] NOT NULL,
PRIMARY KEY CLUSTERED 
(
	[agent_label] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[call_log] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[call_log](
	[call_log_id] [int] IDENTITY(1,1) NOT NULL,
	[channel_id] [int] NOT NULL,
	[conversation_id] [int] NULL,
	[source_number] [nvarchar](30) NOT NULL,
	[ring_group] [nvarchar](50) NULL,
	[destination_number] [nvarchar](30) NOT NULL,
	[src_channel_ref] [nvarchar](100) NOT NULL,
	[dst_channel_ref] [nvarchar](100) NULL,
	[cost_center] [nvarchar](50) NULL,
	[call_status] [nvarchar](20) NOT NULL,
	[duration_seconds] [int] NOT NULL,
	[direction] [nvarchar](10) NOT NULL,
	[is_answered_flag] [bit] NOT NULL,
	[call_date] [date] NOT NULL,
	[call_time] [time](0) NOT NULL,
	[etl_loaded_date] [date] NOT NULL,
	[etl_loaded_time] [time](0) NOT NULL,
	[source_channel] [nvarchar](20) NOT NULL,
 CONSTRAINT [PK_call_log] PRIMARY KEY CLUSTERED 
(
	[call_log_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[campaigns] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[campaigns](
	[campaign_id] [int] IDENTITY(1,1) NOT NULL,
	[channel_id] [int] NOT NULL,
	[platform] [nvarchar](20) NOT NULL,
	[external_id] [nvarchar](255) NOT NULL,
	[title] [nvarchar](255) NULL,
	[content_preview] [nvarchar](max) NULL,
	[permalink] [nvarchar](500) NULL,
	[status] [nvarchar](20) NOT NULL,
	[diffusion_date] [date] NOT NULL,
	[diffusion_time] [time](0) NOT NULL,
 CONSTRAINT [PK_campaigns] PRIMARY KEY CLUSTERED 
(
	[campaign_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Table [dbo].[channel_credentials] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[channel_credentials](
	[channel_id] [int] NOT NULL,
	[access_token_ref] [nvarchar](255) NULL,
	[webhook_verify_token] [nvarchar](255) NULL,
	[updated_date] [date] NOT NULL,
	[updated_time] [time](0) NOT NULL,
 CONSTRAINT [PK_channel_credentials] PRIMARY KEY CLUSTERED 
(
	[channel_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[channel_email_config] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[channel_email_config](
	[channel_id] [int] NOT NULL,
	[imap_host] [nvarchar](255) NULL,
	[imap_port] [int] NOT NULL,
	[smtp_host] [nvarchar](255) NULL,
	[smtp_port] [int] NOT NULL,
	[username] [nvarchar](255) NULL,
 CONSTRAINT [PK_channel_email_config] PRIMARY KEY CLUSTERED 
(
	[channel_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[classification_qualification_matrix] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[classification_qualification_matrix](
	[classification_id] [smallint] NOT NULL,
	[qualification_id] [smallint] NOT NULL,
 CONSTRAINT [PK_class_qual_matrix] PRIMARY KEY CLUSTERED 
(
	[classification_id] ASC,
	[qualification_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[classifications] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[classifications](
	[classification_id] [smallint] IDENTITY(1,1) NOT NULL,
	[label] [nvarchar](50) NOT NULL,
	[sort_order] [tinyint] NOT NULL,
 CONSTRAINT [PK_classifications] PRIMARY KEY CLUSTERED 
(
	[classification_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_classifications_label] UNIQUE NONCLUSTERED 
(
	[label] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[contact_custom_fields] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[contact_custom_fields](
	[contact_id] [uniqueidentifier] NOT NULL,
	[field_key] [nvarchar](100) NOT NULL,
	[field_value] [nvarchar](max) NULL,
 CONSTRAINT [PK_contact_custom_fields] PRIMARY KEY CLUSTERED 
(
	[contact_id] ASC,
	[field_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Table [dbo].[contact_platform_identities] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[contact_platform_identities](
	[identity_key] [int] IDENTITY(1,1) NOT NULL,
	[contact_id] [uniqueidentifier] NOT NULL,
	[platform] [nvarchar](20) NOT NULL,
	[external_id] [nvarchar](255) NOT NULL,
	[username] [nvarchar](255) NULL,
	[name] [nvarchar](255) NULL,
	[avatar] [nvarchar](500) NULL,
	[profile_url] [nvarchar](500) NULL,
	[last_seen_date] [date] NULL,
	[last_seen_time] [time](0) NULL,
 CONSTRAINT [PK_contact_platform_identities] PRIMARY KEY CLUSTERED 
(
	[identity_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_cpi_platform_external] UNIQUE NONCLUSTERED 
(
	[platform] ASC,
	[external_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[contact_tags] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[contact_tags](
	[contact_id] [uniqueidentifier] NOT NULL,
	[tag] [nvarchar](100) NOT NULL,
 CONSTRAINT [PK_contact_tags] PRIMARY KEY CLUSTERED 
(
	[contact_id] ASC,
	[tag] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[contacts] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[contacts](
	[contact_id] [uniqueidentifier] NOT NULL,
	[display_name] [nvarchar](255) NOT NULL,
	[email] [nvarchar](255) NULL,
	[phone] [nvarchar](30) NULL,
	[avatar] [nvarchar](500) NULL,
	[timezone] [nvarchar](50) NULL,
	[locale] [nvarchar](10) NULL,
	[company_name] [nvarchar](255) NULL,
	[job_title] [nvarchar](255) NULL,
	[notes] [nvarchar](max) NULL,
	[total_conversations] [int] NOT NULL,
	[total_messages] [int] NOT NULL,
	[is_blocked] [bit] NOT NULL,
	[is_spam] [bit] NOT NULL,
	[is_vip] [bit] NOT NULL,
	[first_contact_date] [date] NULL,
	[first_contact_time] [time](0) NULL,
	[last_contact_date] [date] NULL,
	[last_contact_time] [time](0) NULL,
	[created_date] [date] NOT NULL,
	[created_time] [time](0) NOT NULL,
	[updated_date] [date] NOT NULL,
	[updated_time] [time](0) NOT NULL,
 CONSTRAINT [PK_contacts] PRIMARY KEY CLUSTERED 
(
	[contact_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Table [dbo].[conversation_agent_unread] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[conversation_agent_unread](
	[conversation_id] [int] NOT NULL,
	[user_id] [int] NOT NULL,
	[unread_count] [int] NOT NULL,
 CONSTRAINT [PK_conversation_agent_unread] PRIMARY KEY CLUSTERED 
(
	[conversation_id] ASC,
	[user_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[conversation_qualification_history] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[conversation_qualification_history](
	[history_id] [int] IDENTITY(1,1) NOT NULL,
	[conversation_id] [int] NOT NULL,
	[qualification_id] [smallint] NOT NULL,
	[changed_by_user_id] [int] NULL,
	[changed_date] [date] NOT NULL,
	[changed_time] [time](0) NOT NULL,
 CONSTRAINT [PK_conversation_qualification_history] PRIMARY KEY CLUSTERED 
(
	[history_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[conversations] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[conversations](
	[conversation_id] [int] IDENTITY(1,1) NOT NULL,
	[platform] [nvarchar](20) NOT NULL,
	[external_id] [nvarchar](255) NOT NULL,
	[channel_id] [int] NOT NULL,
	[contact_id] [uniqueidentifier] NULL,
	[participant_name] [nvarchar](255) NOT NULL,
	[participant_avatar] [nvarchar](500) NULL,
	[participant_external_id] [nvarchar](255) NULL,
	[status] [nvarchar](20) NOT NULL,
	[assigned_to_user_id] [int] NULL,
	[classification_id] [smallint] NOT NULL,
	[classified_by_user_id] [int] NULL,
	[locked_by_user_id] [int] NULL,
	[unread_count] [int] NOT NULL,
	[message_count] [int] NOT NULL,
	[ai_summary] [nvarchar](max) NULL,
	[ai_sentiment] [nvarchar](10) NULL,
	[motif_id] [smallint] NOT NULL,
	[qualification_id] [smallint] NOT NULL,
	[campaign_id] [int] NULL,
	[snoozed_until_date] [date] NULL,
	[snoozed_until_time] [time](0) NULL,
	[classified_date] [date] NULL,
	[classified_time] [time](0) NULL,
	[appointment_date] [date] NULL,
	[appointment_time] [time](0) NULL,
	[locked_date] [date] NULL,
	[locked_time] [time](0) NULL,
	[lock_expires_date] [date] NULL,
	[lock_expires_time] [time](0) NULL,
	[created_date] [date] NOT NULL,
	[created_time] [time](0) NOT NULL,
	[updated_date] [date] NOT NULL,
	[updated_time] [time](0) NOT NULL,
	[deleted_date] [date] NULL,
	[deleted_time] [time](0) NULL,
 CONSTRAINT [PK_conversations] PRIMARY KEY CLUSTERED 
(
	[conversation_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_conversations_platform_external] UNIQUE NONCLUSTERED 
(
	[platform] ASC,
	[external_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Table [dbo].[message] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[message](
	[message_id] [int] IDENTITY(1,1) NOT NULL,
	[conversation_id] [int] NOT NULL,
	[external_id] [nvarchar](255) NULL,
	[sender_type] [nvarchar](10) NOT NULL,
	[sender_user_id] [int] NULL,
	[sender_contact_id] [uniqueidentifier] NULL,
	[message_type] [nvarchar](20) NOT NULL,
	[content] [nvarchar](max) NULL,
	[attachment_url] [nvarchar](500) NULL,
	[is_read] [bit] NOT NULL,
	[sent_date] [date] NOT NULL,
	[sent_time] [time](0) NOT NULL,
	[created_date] [date] NOT NULL,
	[created_time] [time](0) NOT NULL,
 CONSTRAINT [PK_message] PRIMARY KEY CLUSTERED 
(
	[message_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Table [dbo].[motifs_contact] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[motifs_contact](
	[motif_id] [smallint] IDENTITY(1,1) NOT NULL,
	[label] [nvarchar](50) NOT NULL,
	[sort_order] [tinyint] NOT NULL,
 CONSTRAINT [PK_motifs_contact] PRIMARY KEY CLUSTERED 
(
	[motif_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_motifs_contact_label] UNIQUE NONCLUSTERED 
(
	[label] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[qualifications] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[qualifications](
	[qualification_id] [smallint] IDENTITY(1,1) NOT NULL,
	[label] [nvarchar](50) NOT NULL,
	[qualification_group] [nvarchar](20) NOT NULL,
	[is_terminal] [bit] NOT NULL,
	[sort_order] [tinyint] NOT NULL,
 CONSTRAINT [PK_qualifications] PRIMARY KEY CLUSTERED 
(
	[qualification_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_qualifications_label] UNIQUE NONCLUSTERED 
(
	[label] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[users] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[users](
	[user_id] [int] IDENTITY(1,1) NOT NULL,
	[first_name] [nvarchar](100) NOT NULL,
	[last_name] [nvarchar](100) NOT NULL,
	[email] [nvarchar](255) NOT NULL,
	[password_hash] [nvarchar](255) NOT NULL,
	[role] [nvarchar](20) NOT NULL,
	[created_by_user_id] [int] NULL,
	[is_active] [bit] NOT NULL,
	[created_date] [date] NOT NULL,
	[created_time] [time](0) NOT NULL,
	[updated_date] [date] NOT NULL,
	[updated_time] [time](0) NOT NULL,
 CONSTRAINT [PK_users] PRIMARY KEY CLUSTERED 
(
	[user_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_users_email] UNIQUE NONCLUSTERED 
(
	[email] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [stg].[leads_import] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [stg].[leads_import](
	[platform_raw] [nvarchar](50) NULL,
	[channel_label_raw] [nvarchar](1000) NULL,
	[participant_name] [nvarchar](255) NULL,
	[phone_raw] [nvarchar](50) NULL,
	[created_at_raw] [nvarchar](50) NULL,
	[updated_at_raw] [nvarchar](50) NULL,
	[classification_raw] [nvarchar](50) NULL,
	[qualification_raw] [nvarchar](50) NULL,
	[motif_raw] [nvarchar](100) NULL,
	[assigned_agent_raw] [nvarchar](100) NULL,
	[message_count_raw] [nvarchar](20) NULL,
	[unread_count_raw] [nvarchar](20) NULL,
	[last_message_raw] [nvarchar](max) NULL,
	[email_raw] [nvarchar](255) NULL,
	[rdv_le_raw] [nvarchar](50) NULL,
	[loaded_date] [date] NOT NULL,
	[loaded_time] [time](0) NOT NULL
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Index [IX_call_log_datetime] Date de script : 05/10/2026 10:31:08 AM ******/
CREATE NONCLUSTERED INDEX [IX_call_log_datetime] ON [dbo].[call_log]
(
	[call_date] ASC,
	[call_time] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
SET ANSI_PADDING ON
GO
/****** Objet : Index [UX_call_log_natural] Date de script : 05/10/2026 10:31:08 AM ******/
CREATE UNIQUE NONCLUSTERED INDEX [UX_call_log_natural] ON [dbo].[call_log]
(
	[call_date] ASC,
	[call_time] ASC,
	[src_channel_ref] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
SET ANSI_PADDING ON
GO
/****** Objet : Index [UQ_contacts_email] Date de script : 05/10/2026 10:31:08 AM ******/
CREATE UNIQUE NONCLUSTERED INDEX [UQ_contacts_email] ON [dbo].[contacts]
(
	[email] ASC
)
WHERE ([email] IS NOT NULL)
WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
SET ANSI_PADDING ON
GO
/****** Objet : Index [UQ_contacts_phone] Date de script : 05/10/2026 10:31:08 AM ******/
CREATE UNIQUE NONCLUSTERED INDEX [UQ_contacts_phone] ON [dbo].[contacts]
(
	[phone] ASC
)
WHERE ([phone] IS NOT NULL)
WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, IGNORE_DUP_KEY = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_message_conversation_sent] Date de script : 05/10/2026 10:31:08 AM ******/
CREATE NONCLUSTERED INDEX [IX_message_conversation_sent] ON [dbo].[message]
(
	[conversation_id] ASC,
	[sent_date] ASC,
	[sent_time] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
ALTER TABLE [dbo].[call_log] ADD  CONSTRAINT [DF_call_log_duration]  DEFAULT ((0)) FOR [duration_seconds]
GO
ALTER TABLE [dbo].[call_log] ADD  CONSTRAINT [DF_call_log_answered]  DEFAULT ((0)) FOR [is_answered_flag]
GO
ALTER TABLE [dbo].[call_log] ADD  CONSTRAINT [DF_call_log_etl_date]  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [etl_loaded_date]
GO
ALTER TABLE [dbo].[call_log] ADD  CONSTRAINT [DF_call_log_etl_time]  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [etl_loaded_time]
GO
ALTER TABLE [dbo].[campaigns] ADD  CONSTRAINT [DF_campaigns_status]  DEFAULT (N'active') FOR [status]
GO
ALTER TABLE [dbo].[channel_call_config] ADD  CONSTRAINT [DF_channel_call_direction]  DEFAULT (N'both') FOR [direction_type]
GO
ALTER TABLE [dbo].[channel_call_config] ADD  CONSTRAINT [DF_channel_call_is_active]  DEFAULT ((1)) FOR [is_active]
GO
ALTER TABLE [dbo].[channel_call_config] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [created_date]
GO
ALTER TABLE [dbo].[channel_call_config] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [created_time]
GO
ALTER TABLE [dbo].[channel_call_config] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [updated_date]
GO
ALTER TABLE [dbo].[channel_call_config] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [updated_time]
GO
ALTER TABLE [dbo].[channel_credentials] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [updated_date]
GO
ALTER TABLE [dbo].[channel_credentials] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [updated_time]
GO
ALTER TABLE [dbo].[channel_email_config] ADD  CONSTRAINT [DF_channel_email_imap_port]  DEFAULT ((993)) FOR [imap_port]
GO
ALTER TABLE [dbo].[channel_email_config] ADD  CONSTRAINT [DF_channel_email_smtp_port]  DEFAULT ((587)) FOR [smtp_port]
GO
ALTER TABLE [dbo].[channels] ADD  CONSTRAINT [DF_channels_is_active]  DEFAULT ((1)) FOR [is_active]
GO
ALTER TABLE [dbo].[channels] ADD  CONSTRAINT [DF_channels_is_verified]  DEFAULT ((0)) FOR [is_verified]
GO
ALTER TABLE [dbo].[channels] ADD  CONSTRAINT [DF_channels_auto_reply]  DEFAULT ((0)) FOR [auto_reply]
GO
ALTER TABLE [dbo].[channels] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [created_date]
GO
ALTER TABLE [dbo].[channels] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [created_time]
GO
ALTER TABLE [dbo].[channels] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [updated_date]
GO
ALTER TABLE [dbo].[channels] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [updated_time]
GO
ALTER TABLE [dbo].[contacts] ADD  CONSTRAINT [DF_contacts_id]  DEFAULT (newid()) FOR [contact_id]
GO
ALTER TABLE [dbo].[contacts] ADD  CONSTRAINT [DF_contacts_display_name]  DEFAULT (N'Unknown') FOR [display_name]
GO
ALTER TABLE [dbo].[contacts] ADD  CONSTRAINT [DF_contacts_total_conv]  DEFAULT ((0)) FOR [total_conversations]
GO
ALTER TABLE [dbo].[contacts] ADD  CONSTRAINT [DF_contacts_total_msg]  DEFAULT ((0)) FOR [total_messages]
GO
ALTER TABLE [dbo].[contacts] ADD  CONSTRAINT [DF_contacts_is_blocked]  DEFAULT ((0)) FOR [is_blocked]
GO
ALTER TABLE [dbo].[contacts] ADD  CONSTRAINT [DF_contacts_is_spam]  DEFAULT ((0)) FOR [is_spam]
GO
ALTER TABLE [dbo].[contacts] ADD  CONSTRAINT [DF_contacts_is_vip]  DEFAULT ((0)) FOR [is_vip]
GO
ALTER TABLE [dbo].[contacts] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [created_date]
GO
ALTER TABLE [dbo].[contacts] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [created_time]
GO
ALTER TABLE [dbo].[contacts] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [updated_date]
GO
ALTER TABLE [dbo].[contacts] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [updated_time]
GO
ALTER TABLE [dbo].[conversation_agent_unread] ADD  CONSTRAINT [DF_cau_unread]  DEFAULT ((0)) FOR [unread_count]
GO
ALTER TABLE [dbo].[conversations] ADD  CONSTRAINT [DF_conv_participant_name]  DEFAULT (N'Unknown') FOR [participant_name]
GO
ALTER TABLE [dbo].[conversations] ADD  CONSTRAINT [DF_conv_status]  DEFAULT (N'open') FOR [status]
GO
ALTER TABLE [dbo].[conversations] ADD  CONSTRAINT [DF_conv_unread]  DEFAULT ((0)) FOR [unread_count]
GO
ALTER TABLE [dbo].[conversations] ADD  CONSTRAINT [DF_conv_msg_count]  DEFAULT ((0)) FOR [message_count]
GO
ALTER TABLE [dbo].[conversations] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [created_date]
GO
ALTER TABLE [dbo].[conversations] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [created_time]
GO
ALTER TABLE [dbo].[conversations] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [updated_date]
GO
ALTER TABLE [dbo].[conversations] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [updated_time]
GO
ALTER TABLE [dbo].[message] ADD  CONSTRAINT [DF_message_type]  DEFAULT (N'text') FOR [message_type]
GO
ALTER TABLE [dbo].[message] ADD  CONSTRAINT [DF_message_is_read]  DEFAULT ((0)) FOR [is_read]
GO
ALTER TABLE [dbo].[message] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [created_date]
GO
ALTER TABLE [dbo].[message] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [created_time]
GO
ALTER TABLE [dbo].[qualifications] ADD  CONSTRAINT [DF_qualifications_terminal]  DEFAULT ((0)) FOR [is_terminal]
GO
ALTER TABLE [dbo].[stg_call_log] ADD  DEFAULT (CONVERT([date],sysdatetime())) FOR [loaded_date]
GO
ALTER TABLE [dbo].[stg_call_log] ADD  DEFAULT (CONVERT([time](0),sysdatetime())) FOR [loaded_time]
GO
ALTER TABLE [dbo].[users] ADD  CONSTRAINT [DF_users_is_active]  DEFAULT ((1)) FOR [is_active]
GO
ALTER TABLE [dbo].[users] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [created_date]
GO
ALTER TABLE [dbo].[users] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [created_time]
GO
ALTER TABLE [dbo].[users] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [updated_date]
GO
ALTER TABLE [dbo].[users] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [updated_time]
GO
ALTER TABLE [stg].[leads_import] ADD  DEFAULT (CONVERT([date],sysutcdatetime())) FOR [loaded_date]
GO
ALTER TABLE [stg].[leads_import] ADD  DEFAULT (CONVERT([time](0),sysutcdatetime())) FOR [loaded_time]
GO
ALTER TABLE [dbo].[agent_label_map]  WITH CHECK ADD  CONSTRAINT [FK_agent_label_map_user] FOREIGN KEY([user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[agent_label_map] CHECK CONSTRAINT [FK_agent_label_map_user]
GO
ALTER TABLE [dbo].[call_log]  WITH CHECK ADD  CONSTRAINT [FK_call_log_channel] FOREIGN KEY([channel_id])
REFERENCES [dbo].[channels] ([channel_id])
GO
ALTER TABLE [dbo].[call_log] CHECK CONSTRAINT [FK_call_log_channel]
GO
ALTER TABLE [dbo].[call_log]  WITH CHECK ADD  CONSTRAINT [FK_call_log_conversation] FOREIGN KEY([conversation_id])
REFERENCES [dbo].[conversations] ([conversation_id])
GO
ALTER TABLE [dbo].[call_log] CHECK CONSTRAINT [FK_call_log_conversation]
GO
ALTER TABLE [dbo].[campaigns]  WITH CHECK ADD  CONSTRAINT [FK_campaigns_channel] FOREIGN KEY([channel_id])
REFERENCES [dbo].[channels] ([channel_id])
GO
ALTER TABLE [dbo].[campaigns] CHECK CONSTRAINT [FK_campaigns_channel]
GO
ALTER TABLE [dbo].[channel_agents]  WITH CHECK ADD  CONSTRAINT [FK_channel_agents_channel] FOREIGN KEY([channel_id])
REFERENCES [dbo].[channels] ([channel_id])
GO
ALTER TABLE [dbo].[channel_agents] CHECK CONSTRAINT [FK_channel_agents_channel]
GO
ALTER TABLE [dbo].[channel_agents]  WITH CHECK ADD  CONSTRAINT [FK_channel_agents_user] FOREIGN KEY([user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[channel_agents] CHECK CONSTRAINT [FK_channel_agents_user]
GO
ALTER TABLE [dbo].[channel_call_config]  WITH CHECK ADD  CONSTRAINT [FK_channel_call_config_agent] FOREIGN KEY([default_agent_user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[channel_call_config] CHECK CONSTRAINT [FK_channel_call_config_agent]
GO
ALTER TABLE [dbo].[channel_call_config]  WITH CHECK ADD  CONSTRAINT [FK_channel_call_config_channel] FOREIGN KEY([channel_id])
REFERENCES [dbo].[channels] ([channel_id])
GO
ALTER TABLE [dbo].[channel_call_config] CHECK CONSTRAINT [FK_channel_call_config_channel]
GO
ALTER TABLE [dbo].[channel_credentials]  WITH CHECK ADD  CONSTRAINT [FK_channel_credentials_channel] FOREIGN KEY([channel_id])
REFERENCES [dbo].[channels] ([channel_id])
GO
ALTER TABLE [dbo].[channel_credentials] CHECK CONSTRAINT [FK_channel_credentials_channel]
GO
ALTER TABLE [dbo].[channel_email_config]  WITH CHECK ADD  CONSTRAINT [FK_channel_email_config_channel] FOREIGN KEY([channel_id])
REFERENCES [dbo].[channels] ([channel_id])
GO
ALTER TABLE [dbo].[channel_email_config] CHECK CONSTRAINT [FK_channel_email_config_channel]
GO
ALTER TABLE [dbo].[classification_qualification_matrix]  WITH CHECK ADD  CONSTRAINT [FK_cqm_classification] FOREIGN KEY([classification_id])
REFERENCES [dbo].[classifications] ([classification_id])
GO
ALTER TABLE [dbo].[classification_qualification_matrix] CHECK CONSTRAINT [FK_cqm_classification]
GO
ALTER TABLE [dbo].[classification_qualification_matrix]  WITH CHECK ADD  CONSTRAINT [FK_cqm_qualification] FOREIGN KEY([qualification_id])
REFERENCES [dbo].[qualifications] ([qualification_id])
GO
ALTER TABLE [dbo].[classification_qualification_matrix] CHECK CONSTRAINT [FK_cqm_qualification]
GO
ALTER TABLE [dbo].[contact_custom_fields]  WITH CHECK ADD  CONSTRAINT [FK_contact_custom_fields_contact] FOREIGN KEY([contact_id])
REFERENCES [dbo].[contacts] ([contact_id])
GO
ALTER TABLE [dbo].[contact_custom_fields] CHECK CONSTRAINT [FK_contact_custom_fields_contact]
GO
ALTER TABLE [dbo].[contact_platform_identities]  WITH CHECK ADD  CONSTRAINT [FK_cpi_contact] FOREIGN KEY([contact_id])
REFERENCES [dbo].[contacts] ([contact_id])
GO
ALTER TABLE [dbo].[contact_platform_identities] CHECK CONSTRAINT [FK_cpi_contact]
GO
ALTER TABLE [dbo].[contact_tags]  WITH CHECK ADD  CONSTRAINT [FK_contact_tags_contact] FOREIGN KEY([contact_id])
REFERENCES [dbo].[contacts] ([contact_id])
GO
ALTER TABLE [dbo].[contact_tags] CHECK CONSTRAINT [FK_contact_tags_contact]
GO
ALTER TABLE [dbo].[conversation_agent_unread]  WITH CHECK ADD  CONSTRAINT [FK_cau_conversation] FOREIGN KEY([conversation_id])
REFERENCES [dbo].[conversations] ([conversation_id])
GO
ALTER TABLE [dbo].[conversation_agent_unread] CHECK CONSTRAINT [FK_cau_conversation]
GO
ALTER TABLE [dbo].[conversation_agent_unread]  WITH CHECK ADD  CONSTRAINT [FK_cau_user] FOREIGN KEY([user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[conversation_agent_unread] CHECK CONSTRAINT [FK_cau_user]
GO
ALTER TABLE [dbo].[conversation_qualification_history]  WITH CHECK ADD  CONSTRAINT [FK_cqh_conversation] FOREIGN KEY([conversation_id])
REFERENCES [dbo].[conversations] ([conversation_id])
GO
ALTER TABLE [dbo].[conversation_qualification_history] CHECK CONSTRAINT [FK_cqh_conversation]
GO
ALTER TABLE [dbo].[conversation_qualification_history]  WITH CHECK ADD  CONSTRAINT [FK_cqh_qualification] FOREIGN KEY([qualification_id])
REFERENCES [dbo].[qualifications] ([qualification_id])
GO
ALTER TABLE [dbo].[conversation_qualification_history] CHECK CONSTRAINT [FK_cqh_qualification]
GO
ALTER TABLE [dbo].[conversation_qualification_history]  WITH CHECK ADD  CONSTRAINT [FK_cqh_user] FOREIGN KEY([changed_by_user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[conversation_qualification_history] CHECK CONSTRAINT [FK_cqh_user]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_assigned_to] FOREIGN KEY([assigned_to_user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_assigned_to]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_campaign] FOREIGN KEY([campaign_id])
REFERENCES [dbo].[campaigns] ([campaign_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_campaign]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_channel] FOREIGN KEY([channel_id])
REFERENCES [dbo].[channels] ([channel_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_channel]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_classification] FOREIGN KEY([classification_id])
REFERENCES [dbo].[classifications] ([classification_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_classification]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_classified_by] FOREIGN KEY([classified_by_user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_classified_by]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_contact] FOREIGN KEY([contact_id])
REFERENCES [dbo].[contacts] ([contact_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_contact]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_locked_by] FOREIGN KEY([locked_by_user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_locked_by]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_motif] FOREIGN KEY([motif_id])
REFERENCES [dbo].[motifs_contact] ([motif_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_motif]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [FK_conv_qualification] FOREIGN KEY([qualification_id])
REFERENCES [dbo].[qualifications] ([qualification_id])
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [FK_conv_qualification]
GO
ALTER TABLE [dbo].[extension_agents]  WITH CHECK ADD  CONSTRAINT [FK_extension_agents_user] FOREIGN KEY([user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[extension_agents] CHECK CONSTRAINT [FK_extension_agents_user]
GO
ALTER TABLE [dbo].[message]  WITH CHECK ADD  CONSTRAINT [FK_message_conversation] FOREIGN KEY([conversation_id])
REFERENCES [dbo].[conversations] ([conversation_id])
GO
ALTER TABLE [dbo].[message] CHECK CONSTRAINT [FK_message_conversation]
GO
ALTER TABLE [dbo].[message]  WITH CHECK ADD  CONSTRAINT [FK_message_sender_contact] FOREIGN KEY([sender_contact_id])
REFERENCES [dbo].[contacts] ([contact_id])
GO
ALTER TABLE [dbo].[message] CHECK CONSTRAINT [FK_message_sender_contact]
GO
ALTER TABLE [dbo].[message]  WITH CHECK ADD  CONSTRAINT [FK_message_sender_user] FOREIGN KEY([sender_user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[message] CHECK CONSTRAINT [FK_message_sender_user]
GO
ALTER TABLE [dbo].[users]  WITH CHECK ADD  CONSTRAINT [FK_users_created_by] FOREIGN KEY([created_by_user_id])
REFERENCES [dbo].[users] ([user_id])
GO
ALTER TABLE [dbo].[users] CHECK CONSTRAINT [FK_users_created_by]
GO
ALTER TABLE [dbo].[call_log]  WITH CHECK ADD  CONSTRAINT [CK_call_log_direction] CHECK  (([direction]=N'internal' OR [direction]=N'outbound' OR [direction]=N'inbound'))
GO
ALTER TABLE [dbo].[call_log] CHECK CONSTRAINT [CK_call_log_direction]
GO
ALTER TABLE [dbo].[call_log]  WITH CHECK ADD  CONSTRAINT [CK_call_log_status] CHECK  (([call_status]=N'BUSY' OR [call_status]=N'NO ANSWER' OR [call_status]=N'ANSWERED'))
GO
ALTER TABLE [dbo].[call_log] CHECK CONSTRAINT [CK_call_log_status]
GO
ALTER TABLE [dbo].[campaigns]  WITH CHECK ADD  CONSTRAINT [CK_campaigns_platform] CHECK  (([platform]=N'tiktok' OR [platform]=N'instagram' OR [platform]=N'facebook'))
GO
ALTER TABLE [dbo].[campaigns] CHECK CONSTRAINT [CK_campaigns_platform]
GO
ALTER TABLE [dbo].[campaigns]  WITH CHECK ADD  CONSTRAINT [CK_campaigns_status] CHECK  (([status]=N'archived' OR [status]=N'active'))
GO
ALTER TABLE [dbo].[campaigns] CHECK CONSTRAINT [CK_campaigns_status]
GO
ALTER TABLE [dbo].[channel_call_config]  WITH CHECK ADD  CONSTRAINT [CK_channel_call_direction] CHECK  (([direction_type]=N'both' OR [direction_type]=N'outbound' OR [direction_type]=N'inbound'))
GO
ALTER TABLE [dbo].[channel_call_config] CHECK CONSTRAINT [CK_channel_call_direction]
GO
ALTER TABLE [dbo].[channels]  WITH CHECK ADD  CONSTRAINT [CK_channels_platform] CHECK  (([platform]=N'call' OR [platform]=N'email' OR [platform]=N'tiktok' OR [platform]=N'whatsapp' OR [platform]=N'instagram' OR [platform]=N'facebook'))
GO
ALTER TABLE [dbo].[channels] CHECK CONSTRAINT [CK_channels_platform]
GO
ALTER TABLE [dbo].[classifications]  WITH CHECK ADD  CONSTRAINT [CK_classifications_label] CHECK  (([label]=N'Dossier confirmé' OR [label]=N'Paiement en cours' OR [label]=N'Réservation passée' OR [label]=N'Devis envoyé' OR [label]=N'Offre présentée' OR [label]=N'Contact établi' OR [label]=N'Nouveau lead'))
GO
ALTER TABLE [dbo].[classifications] CHECK CONSTRAINT [CK_classifications_label]
GO
ALTER TABLE [dbo].[contact_platform_identities]  WITH CHECK ADD  CONSTRAINT [CK_cpi_platform] CHECK  (([platform]=N'tiktok' OR [platform]=N'email' OR [platform]=N'whatsapp' OR [platform]=N'instagram' OR [platform]=N'facebook'))
GO
ALTER TABLE [dbo].[contact_platform_identities] CHECK CONSTRAINT [CK_cpi_platform]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [CK_conv_platform] CHECK  (([platform]=N'call' OR [platform]=N'email' OR [platform]=N'tiktok' OR [platform]=N'whatsapp' OR [platform]=N'instagram' OR [platform]=N'facebook'))
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [CK_conv_platform]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [CK_conv_sentiment] CHECK  (([ai_sentiment]=N'negative' OR [ai_sentiment]=N'neutral' OR [ai_sentiment]=N'positive' OR [ai_sentiment] IS NULL))
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [CK_conv_sentiment]
GO
ALTER TABLE [dbo].[conversations]  WITH CHECK ADD  CONSTRAINT [CK_conv_status] CHECK  (([status]=N'resolved' OR [status]=N'pending' OR [status]=N'open'))
GO
ALTER TABLE [dbo].[conversations] CHECK CONSTRAINT [CK_conv_status]
GO
ALTER TABLE [dbo].[message]  WITH CHECK ADD  CONSTRAINT [CK_message_sender_type] CHECK  (([sender_type]=N'system' OR [sender_type]=N'contact' OR [sender_type]=N'agent'))
GO
ALTER TABLE [dbo].[message] CHECK CONSTRAINT [CK_message_sender_type]
GO
ALTER TABLE [dbo].[message]  WITH CHECK ADD  CONSTRAINT [CK_message_type] CHECK  (([message_type]=N'call_event' OR [message_type]=N'document' OR [message_type]=N'audio' OR [message_type]=N'video' OR [message_type]=N'image' OR [message_type]=N'text'))
GO
ALTER TABLE [dbo].[message] CHECK CONSTRAINT [CK_message_type]
GO
ALTER TABLE [dbo].[qualifications]  WITH CHECK ADD  CONSTRAINT [CK_qualifications_group] CHECK  (([qualification_group]=N'Perdu' OR [qualification_group]=N'Gagné' OR [qualification_group]=N'En cours' OR [qualification_group]=N'Nouveau'))
GO
ALTER TABLE [dbo].[qualifications] CHECK CONSTRAINT [CK_qualifications_group]
GO
ALTER TABLE [dbo].[qualifications]  WITH CHECK ADD  CONSTRAINT [CK_qualifications_label] CHECK  (([label]=N'Réservation annulée' OR [label]=N'Dossier confirmé' OR [label]=N'En cours' OR [label]=N'Offre concurrente' OR [label]=N'Prix trop élevé' OR [label]=N'Non intéressé' OR [label]=N'Injoignable' OR [label]=N'En réflexion' OR [label]=N'En attente de réponse' OR [label]=N'Nouveau lead'))
GO
ALTER TABLE [dbo].[qualifications] CHECK CONSTRAINT [CK_qualifications_label]
GO
ALTER TABLE [dbo].[users]  WITH CHECK ADD  CONSTRAINT [CK_users_role] CHECK  (([role]=N'agent' OR [role]=N'manager' OR [role]=N'admin'))
GO
ALTER TABLE [dbo].[users] CHECK CONSTRAINT [CK_users_role]
GO
/****** Objet : StoredProcedure [dbo].[usp_load_fact_call] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
 
/* ---------------------------------------------------------------------
   4b. usp_load_fact_call : extension = texte entre 'SIP/' et le premier '-'
       ex: SIP/101-00000012 -> 101
   --------------------------------------------------------------------- */
CREATE   PROCEDURE [dbo].[usp_load_fact_call]
AS
BEGIN
    SET NOCOUNT ON;
 
    ;WITH staged AS (
        SELECT
            cl.call_log_id,
            ISNULL(fl.lead_key, -1) AS lead_key,
            CAST(FORMAT(cl.call_date, 'yyyyMMdd') AS INT) AS date_call_key,
            ISNULL(dch.channel_key, -1) AS channel_key,
            ISNULL(da_group.agent_key, ISNULL(da_direct.agent_key, -1)) AS agent_key,
            ISNULL(cl.ring_group, N'Sans groupe') AS ring_group,
            cl.direction,
            cl.call_status,
            cl.duration_seconds,
            cl.is_answered_flag
        FROM dbo.src_call_log cl
        CROSS APPLY (
            SELECT dst_ext = CASE WHEN cl.dst_channel_ref LIKE N'SIP/%-%'
                                  THEN SUBSTRING(cl.dst_channel_ref, 5, CHARINDEX(N'-', cl.dst_channel_ref, 5) - 5)
                             END
        ) x
        LEFT JOIN dbo.fact_lead fl ON fl.conversation_id = cl.conversation_id
        LEFT JOIN dbo.dim_channel dch ON dch.channel_id = cl.channel_id AND dch.is_current = 1
        LEFT JOIN dbo.src_extension_agents ea
            ON ea.extension_number = x.dst_ext
           AND UnifiedBox1.dbo.fn_DateTimeCombine(cl.call_date, cl.call_time)
                 >= UnifiedBox1.dbo.fn_DateTimeCombine(ea.valid_from_date, ea.valid_from_time)
           AND (ea.valid_to_date IS NULL
                OR UnifiedBox1.dbo.fn_DateTimeCombine(cl.call_date, cl.call_time)
                     < UnifiedBox1.dbo.fn_DateTimeCombine(ea.valid_to_date, ea.valid_to_time))
        LEFT JOIN dbo.dim_agent da_group ON da_group.user_id = ea.user_id AND da_group.is_current = 1
        LEFT JOIN dbo.src_channel_call_config ccc ON ccc.channel_id = cl.channel_id
        LEFT JOIN dbo.dim_agent da_direct ON da_direct.user_id = ccc.default_agent_user_id AND da_direct.is_current = 1
    )
    MERGE dbo.fact_call AS tgt
    USING staged AS src
    ON tgt.call_log_id = src.call_log_id
    WHEN MATCHED THEN
        UPDATE SET
            lead_key = src.lead_key, channel_key = src.channel_key, agent_key = src.agent_key,
            ring_group = src.ring_group, direction = src.direction, call_status = src.call_status,
            duration_seconds = src.duration_seconds, is_answered_flag = src.is_answered_flag,
            etl_loaded_at = SYSUTCDATETIME()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (call_log_id, lead_key, date_call_key, channel_key, agent_key, ring_group, direction, call_status, duration_seconds, is_answered_flag)
        VALUES (src.call_log_id, src.lead_key, src.date_call_key, src.channel_key, src.agent_key, src.ring_group, src.direction, src.call_status, src.duration_seconds, src.is_answered_flag);
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_leads_from_staging] Date de script : 05/10/2026 10:31:08 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/* ---- FIX 4 + 5 : import procedure ---- */
CREATE   PROCEDURE [dbo].[usp_load_leads_from_staging]
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRANSACTION;

    BEGIN TRY

        IF OBJECT_ID('tempdb..#leads') IS NOT NULL DROP TABLE #leads;

        SELECT
            platform             = LOWER(LTRIM(RTRIM(platform_raw))),
            channel_label        = NULLIF(LTRIM(RTRIM(channel_label_raw)), ''),
            participant_name     = NULLIF(LTRIM(RTRIM(participant_name)), 'Unknown'),
            phone                = NULLIF(LTRIM(RTRIM(phone_raw)), ''),
            email                = NULLIF(LTRIM(RTRIM(email_raw)), ''),
            first_contact_at     = TRY_CONVERT(datetime2(0), LTRIM(RTRIM(created_at_raw)), 103),
            last_contact_at      = TRY_CONVERT(datetime2(0), LTRIM(RTRIM(updated_at_raw)), 103),
            classification_label = ISNULL(NULLIF(LTRIM(RTRIM(classification_raw)), ''), N'Non classifié'),
            -- FIX 5: blank qualification = initial state instead of NULL (column is NOT NULL)
            qualification_label  = ISNULL(NULLIF(LTRIM(RTRIM(qualification_raw)), ''), N'Nouveau'),
            motif_label          = NULLIF(LTRIM(RTRIM(motif_raw)), ''),
            rdv_le               = TRY_CONVERT(datetime2(0), LTRIM(RTRIM(rdv_le_raw)), 103),
            assigned_agent_label = NULLIF(LTRIM(RTRIM(assigned_agent_raw)), ''),
            message_count        = TRY_CONVERT(int, message_count_raw),
            unread_count         = TRY_CONVERT(int, unread_count_raw),
            last_message         = last_message_raw
        INTO #leads
        FROM stg.leads_import;

        INSERT INTO dbo.classifications (label, sort_order)
        SELECT DISTINCT l.classification_label, 99
        FROM #leads l
        WHERE NOT EXISTS (SELECT 1 FROM dbo.classifications c WHERE c.label = l.classification_label);

        INSERT INTO dbo.qualifications (label, qualification_group, is_terminal, sort_order)
        SELECT DISTINCT l.qualification_label, 'Nouveau', 0, 99
        FROM #leads l
        WHERE l.qualification_label IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.qualifications q WHERE q.label = l.qualification_label);

        IF NOT EXISTS (SELECT 1 FROM dbo.motifs_contact WHERE label = N'Non spécifié')
            INSERT INTO dbo.motifs_contact (label, sort_order) VALUES (N'Non spécifié', 0);

        INSERT INTO dbo.motifs_contact (label, sort_order)
        SELECT DISTINCT l.motif_label, 99
        FROM #leads l
        WHERE l.motif_label IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.motifs_contact m WHERE m.label = l.motif_label);

        INSERT INTO dbo.channels (platform, name, external_id, is_active, is_verified, auto_reply, created_date, created_time, updated_date, updated_time)
        SELECT DISTINCT l.platform, l.platform, 'IMPORT-' + l.platform, 1, 0, 0,
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME()),
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME())
        FROM #leads l
        WHERE NOT EXISTS (
            SELECT 1 FROM dbo.channels c
            WHERE c.platform = l.platform AND c.external_id = 'IMPORT-' + l.platform
        );

        IF OBJECT_ID('tempdb..#resolved') IS NOT NULL DROP TABLE #resolved;

        SELECT
            l.*,
            channel_id          = ch.channel_id,
            classification_id   = cl.classification_id,
            qualification_id    = qu.qualification_id,
            motif_id            = ISNULL(mo.motif_id, mo_default.motif_id),
            assigned_to_user_id = (
                SELECT TOP 1 u.user_id
                FROM dbo.users u
                WHERE l.assigned_agent_label IS NOT NULL
                  AND LOWER(u.first_name + ' ' + u.last_name) = LOWER(l.assigned_agent_label)
            )
        INTO #resolved
        FROM #leads l
        JOIN dbo.channels ch
            ON ch.platform = l.platform AND ch.external_id = 'IMPORT-' + l.platform
        JOIN dbo.classifications cl
            ON cl.label = l.classification_label
        LEFT JOIN dbo.qualifications qu
            ON qu.label = l.qualification_label
        LEFT JOIN dbo.motifs_contact mo
            ON mo.label = l.motif_label
        CROSS JOIN (
            SELECT motif_id FROM dbo.motifs_contact WHERE label = N'Non spécifié'
        ) mo_default;

        INSERT INTO dbo.contacts (display_name, phone, email, created_date, created_time, updated_date, updated_time)
        SELECT DISTINCT r.participant_name, r.phone, r.email,
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME()),
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME())
        FROM #resolved r
        WHERE r.phone IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.contacts c WHERE c.phone = r.phone);

        INSERT INTO dbo.contacts (display_name, email, created_date, created_time, updated_date, updated_time)
        SELECT DISTINCT r.participant_name, r.email,
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME()),
               CONVERT(date, SYSUTCDATETIME()), CONVERT(time(0), SYSUTCDATETIME())
        FROM #resolved r
        WHERE r.phone IS NULL
          AND r.participant_name IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.contacts c WHERE c.display_name = r.participant_name AND c.phone IS NULL);

        ALTER TABLE #resolved ADD contact_id uniqueidentifier NULL;

        UPDATE r
        SET r.contact_id = c.contact_id
        FROM #resolved r
        JOIN dbo.contacts c ON c.phone = r.phone
        WHERE r.phone IS NOT NULL;

        UPDATE r
        SET r.contact_id = c.contact_id
        FROM #resolved r
        JOIN dbo.contacts c ON c.display_name = r.participant_name AND c.phone IS NULL
        WHERE r.phone IS NULL AND r.contact_id IS NULL;

        INSERT INTO dbo.classification_qualification_matrix (classification_id, qualification_id)
        SELECT DISTINCT r.classification_id, r.qualification_id
        FROM #resolved r
        WHERE r.qualification_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM dbo.classification_qualification_matrix m
              WHERE m.classification_id = r.classification_id
                AND m.qualification_id = r.qualification_id
          );

        MERGE dbo.conversations AS tgt
        USING (
            SELECT * FROM #resolved WHERE contact_id IS NOT NULL
        ) AS src
        ON tgt.channel_id = src.channel_id
           AND tgt.contact_id = src.contact_id
           AND tgt.participant_name = src.participant_name
           AND tgt.created_date = CONVERT(date, src.first_contact_at)
           AND tgt.created_time = CONVERT(time(0), src.first_contact_at)
        WHEN MATCHED THEN
            UPDATE SET
                tgt.updated_date = CONVERT(date, src.last_contact_at),
                tgt.updated_time = CONVERT(time(0), src.last_contact_at),
                tgt.classification_id = src.classification_id,
                tgt.qualification_id = src.qualification_id,
                tgt.motif_id = src.motif_id,
                tgt.assigned_to_user_id = src.assigned_to_user_id,
                tgt.appointment_date = CONVERT(date, src.rdv_le),
                tgt.appointment_time = CONVERT(time(0), src.rdv_le),
                tgt.message_count = ISNULL(src.message_count, tgt.message_count),
                tgt.unread_count = ISNULL(src.unread_count, tgt.unread_count),
                -- FIX 4: keep/derive a classification date (best estimate = last contact)
                tgt.classified_date = CASE WHEN src.classification_label <> N'Non classifié'
                                           THEN ISNULL(tgt.classified_date, CONVERT(date, src.last_contact_at))
                                           ELSE tgt.classified_date END,
                tgt.classified_time = CASE WHEN src.classification_label <> N'Non classifié'
                                           THEN ISNULL(tgt.classified_time, CONVERT(time(0), src.last_contact_at))
                                           ELSE tgt.classified_time END
        WHEN NOT MATCHED THEN
            INSERT (
                platform, external_id, channel_id, contact_id, participant_name,
                status, classification_id, qualification_id, motif_id,
                assigned_to_user_id, appointment_date, appointment_time, message_count, unread_count,
                classified_date, classified_time,
                created_date, created_time, updated_date, updated_time
            )
            VALUES (
                src.platform,
                CONCAT('IMPORT-', src.platform, '-', CONVERT(nvarchar(36), NEWID())),
                src.channel_id, src.contact_id, src.participant_name,
                'open', src.classification_id, src.qualification_id, src.motif_id,
                src.assigned_to_user_id,
                CONVERT(date, src.rdv_le), CONVERT(time(0), src.rdv_le),
                ISNULL(src.message_count, 0), ISNULL(src.unread_count, 0),
                CASE WHEN src.classification_label <> N'Non classifié' THEN CONVERT(date, src.last_contact_at) END,
                CASE WHEN src.classification_label <> N'Non classifié' THEN CONVERT(time(0), src.last_contact_at) END,
                CONVERT(date, src.first_contact_at), CONVERT(time(0), src.first_contact_at),
                CONVERT(date, src.last_contact_at), CONVERT(time(0), src.last_contact_at)
            );

        -- FIX 4: qualification history for imported leads (only the state we actually know:
        -- current qualification, dated at last contact). Re-runs only add a row when it changed.
        INSERT INTO dbo.conversation_qualification_history
               (conversation_id, qualification_id, changed_by_user_id, changed_date, changed_time)
        SELECT c.conversation_id, c.qualification_id, c.assigned_to_user_id, c.updated_date, c.updated_time
        FROM dbo.conversations c
        OUTER APPLY (
            SELECT TOP 1 h.qualification_id
            FROM dbo.conversation_qualification_history h
            WHERE h.conversation_id = c.conversation_id
            ORDER BY h.changed_date DESC, h.changed_time DESC, h.history_id DESC
        ) lh
        WHERE c.external_id LIKE N'IMPORT-%'
          AND (lh.qualification_id IS NULL OR lh.qualification_id <> c.qualification_id);

        COMMIT TRANSACTION;

        SELECT
            leads_in_staging = (SELECT COUNT(*) FROM stg.leads_import),
            leads_sans_contact_resolu = (SELECT COUNT(*) FROM #resolved WHERE contact_id IS NULL);

    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END
GO
USE [master]
GO
ALTER DATABASE [UnifiedBox1] SET  READ_WRITE 
GO
