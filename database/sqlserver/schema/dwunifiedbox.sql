USE [master]
GO
/****** Objet : Database [UnifiedBoxDW] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE DATABASE [UnifiedBoxDW]
 CONTAINMENT = NONE
 ON  PRIMARY 
( NAME = N'UnifiedBoxDW', FILENAME = N'C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\DATA\UnifiedBoxDW.mdf' , SIZE = 73728KB , MAXSIZE = UNLIMITED, FILEGROWTH = 65536KB )
 LOG ON 
( NAME = N'UnifiedBoxDW_log', FILENAME = N'C:\Program Files\Microsoft SQL Server\MSSQL17.MSSQLSERVER\MSSQL\DATA\UnifiedBoxDW_log.ldf' , SIZE = 73728KB , MAXSIZE = 2048GB , FILEGROWTH = 65536KB )
 WITH CATALOG_COLLATION = DATABASE_DEFAULT, LEDGER = OFF
GO
ALTER DATABASE [UnifiedBoxDW] SET COMPATIBILITY_LEVEL = 170
GO
IF (1 = FULLTEXTSERVICEPROPERTY('IsFullTextInstalled'))
begin
EXEC [UnifiedBoxDW].[dbo].[sp_fulltext_database] @action = 'enable'
end
GO
ALTER DATABASE [UnifiedBoxDW] SET ANSI_NULL_DEFAULT OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET ANSI_NULLS OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET ANSI_PADDING OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET ANSI_WARNINGS OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET ARITHABORT OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET AUTO_CLOSE OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET AUTO_SHRINK OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET AUTO_UPDATE_STATISTICS ON 
GO
ALTER DATABASE [UnifiedBoxDW] SET CURSOR_CLOSE_ON_COMMIT OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET CURSOR_DEFAULT  GLOBAL 
GO
ALTER DATABASE [UnifiedBoxDW] SET CONCAT_NULL_YIELDS_NULL OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET NUMERIC_ROUNDABORT OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET QUOTED_IDENTIFIER OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET RECURSIVE_TRIGGERS OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET  DISABLE_BROKER 
GO
ALTER DATABASE [UnifiedBoxDW] SET AUTO_UPDATE_STATISTICS_ASYNC OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET DATE_CORRELATION_OPTIMIZATION OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET TRUSTWORTHY OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET ALLOW_SNAPSHOT_ISOLATION OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET PARAMETERIZATION SIMPLE 
GO
ALTER DATABASE [UnifiedBoxDW] SET READ_COMMITTED_SNAPSHOT OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET HONOR_BROKER_PRIORITY OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET RECOVERY SIMPLE 
GO
ALTER DATABASE [UnifiedBoxDW] SET  MULTI_USER 
GO
ALTER DATABASE [UnifiedBoxDW] SET PAGE_VERIFY CHECKSUM  
GO
ALTER DATABASE [UnifiedBoxDW] SET DB_CHAINING OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET FILESTREAM( NON_TRANSACTED_ACCESS = OFF ) 
GO
ALTER DATABASE [UnifiedBoxDW] SET TARGET_RECOVERY_TIME = 60 SECONDS 
GO
ALTER DATABASE [UnifiedBoxDW] SET DELAYED_DURABILITY = DISABLED 
GO
ALTER DATABASE [UnifiedBoxDW] SET OPTIMIZED_LOCKING = OFF 
GO
ALTER DATABASE [UnifiedBoxDW] SET ACCELERATED_DATABASE_RECOVERY = OFF  
GO
ALTER DATABASE [UnifiedBoxDW] SET QUERY_STORE = ON
GO
ALTER DATABASE [UnifiedBoxDW] SET QUERY_STORE (OPERATION_MODE = READ_WRITE, CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = 30), DATA_FLUSH_INTERVAL_SECONDS = 900, INTERVAL_LENGTH_MINUTES = 60, MAX_STORAGE_SIZE_MB = 1000, QUERY_CAPTURE_MODE = AUTO, SIZE_BASED_CLEANUP_MODE = AUTO, MAX_PLANS_PER_QUERY = 200, WAIT_STATS_CAPTURE_MODE = ON)
GO
USE [UnifiedBoxDW]
GO
/****** Objet : User [powerbi_reader] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE USER [powerbi_reader] FOR LOGIN [powerbi_reader] WITH DEFAULT_SCHEMA=[dbo]
GO
/****** Objet : Synonym [dbo].[src_call_log] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_call_log] FOR [UnifiedBox1].[dbo].[call_log]
GO
/****** Objet : Synonym [dbo].[src_campaigns] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_campaigns] FOR [UnifiedBox1].[dbo].[campaigns]
GO
/****** Objet : Synonym [dbo].[src_channel_call_config] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_channel_call_config] FOR [UnifiedBox1].[dbo].[channel_call_config]
GO
/****** Objet : Synonym [dbo].[src_channels] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_channels] FOR [UnifiedBox1].[dbo].[channels]
GO
/****** Objet : Synonym [dbo].[src_classifications] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_classifications] FOR [UnifiedBox1].[dbo].[classifications]
GO
/****** Objet : Synonym [dbo].[src_contacts] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_contacts] FOR [UnifiedBox1].[dbo].[contacts]
GO
/****** Objet : Synonym [dbo].[src_conversation_qualification_history] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_conversation_qualification_history] FOR [UnifiedBox1].[dbo].[conversation_qualification_history]
GO
/****** Objet : Synonym [dbo].[src_conversations] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_conversations] FOR [UnifiedBox1].[dbo].[conversations]
GO
/****** Objet : Synonym [dbo].[src_extension_agents] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_extension_agents] FOR [UnifiedBox1].[dbo].[extension_agents]
GO
/****** Objet : Synonym [dbo].[src_message] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_message] FOR [UnifiedBox1].[dbo].[message]
GO
/****** Objet : Synonym [dbo].[src_motifs_contact] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_motifs_contact] FOR [UnifiedBox1].[dbo].[motifs_contact]
GO
/****** Objet : Synonym [dbo].[src_qualifications] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_qualifications] FOR [UnifiedBox1].[dbo].[qualifications]
GO
/****** Objet : Synonym [dbo].[src_users] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE SYNONYM [dbo].[src_users] FOR [UnifiedBox1].[dbo].[users]
GO
/****** Objet : Table [dbo].[dim_agent] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_agent](
	[agent_key] [bigint] IDENTITY(1,1) NOT NULL,
	[user_id] [int] NULL,
	[full_name] [nvarchar](255) NOT NULL,
	[role] [nvarchar](20) NULL,
	[is_active] [bit] NOT NULL,
	[effective_date] [datetime2](0) NOT NULL,
	[expiry_date] [datetime2](0) NULL,
	[is_current] [bit] NOT NULL,
 CONSTRAINT [PK_dim_agent] PRIMARY KEY CLUSTERED 
(
	[agent_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[dim_campaign] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_campaign](
	[campaign_key] [bigint] IDENTITY(1,1) NOT NULL,
	[campaign_id] [int] NULL,
	[platform] [nvarchar](20) NULL,
	[title] [nvarchar](255) NULL,
	[content_preview] [nvarchar](max) NULL,
	[permalink] [nvarchar](500) NULL,
	[date_diffusion] [datetime2](0) NULL,
	[status] [nvarchar](20) NULL,
 CONSTRAINT [PK_dim_campaign] PRIMARY KEY CLUSTERED 
(
	[campaign_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Table [dbo].[dim_channel] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_channel](
	[channel_key] [bigint] IDENTITY(1,1) NOT NULL,
	[channel_id] [int] NULL,
	[platform] [nvarchar](20) NOT NULL,
	[channel_name] [nvarchar](255) NOT NULL,
	[external_id] [nvarchar](255) NULL,
	[is_active] [bit] NOT NULL,
	[is_verified] [bit] NOT NULL,
	[auto_reply] [bit] NOT NULL,
	[effective_date] [datetime2](0) NOT NULL,
	[expiry_date] [datetime2](0) NULL,
	[is_current] [bit] NOT NULL,
 CONSTRAINT [PK_dim_channel] PRIMARY KEY CLUSTERED 
(
	[channel_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[dim_classification] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_classification](
	[classification_key] [int] NOT NULL,
	[classification_label_fr] [nvarchar](100) NOT NULL,
	[sort_order] [tinyint] NOT NULL,
 CONSTRAINT [PK_dim_classification] PRIMARY KEY CLUSTERED 
(
	[classification_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[dim_contact] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_contact](
	[contact_key] [bigint] IDENTITY(1,1) NOT NULL,
	[contact_id] [uniqueidentifier] NULL,
	[display_name] [nvarchar](255) NOT NULL,
	[email] [nvarchar](255) NULL,
	[phone] [nvarchar](30) NULL,
	[company_name] [nvarchar](255) NULL,
	[job_title] [nvarchar](255) NULL,
	[is_vip] [bit] NOT NULL,
	[is_blocked] [bit] NOT NULL,
	[is_spam] [bit] NOT NULL,
	[effective_date] [datetime2](0) NOT NULL,
	[expiry_date] [datetime2](0) NULL,
	[is_current] [bit] NOT NULL,
 CONSTRAINT [PK_dim_contact] PRIMARY KEY CLUSTERED 
(
	[contact_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[dim_date] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_date](
	[date_key] [int] NOT NULL,
	[full_date] [date] NOT NULL,
	[day_name_fr] [nvarchar](20) NOT NULL,
	[week_number] [tinyint] NOT NULL,
	[month_number] [tinyint] NOT NULL,
	[month_name_fr] [nvarchar](20) NOT NULL,
	[month_year_label] [nvarchar](7) NOT NULL,
	[quarter] [tinyint] NOT NULL,
	[year] [smallint] NOT NULL,
	[is_weekend] [bit] NOT NULL,
 CONSTRAINT [PK_dim_date] PRIMARY KEY CLUSTERED 
(
	[date_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_dim_date_full_date] UNIQUE NONCLUSTERED 
(
	[full_date] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[dim_motif_contact] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_motif_contact](
	[motif_key] [int] NOT NULL,
	[motif_label_fr] [nvarchar](50) NOT NULL,
 CONSTRAINT [PK_dim_motif_contact] PRIMARY KEY CLUSTERED 
(
	[motif_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[dim_qualification] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_qualification](
	[qualification_key] [int] NOT NULL,
	[qualification_label] [nvarchar](100) NOT NULL,
	[qualification_group] [nvarchar](20) NOT NULL,
	[is_terminal] [bit] NOT NULL,
 CONSTRAINT [PK_dim_qualification] PRIMARY KEY CLUSTERED 
(
	[qualification_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[dim_status] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[dim_status](
	[status_key] [int] NOT NULL,
	[status_code] [nvarchar](20) NOT NULL,
	[status_label_fr] [nvarchar](50) NOT NULL,
 CONSTRAINT [PK_dim_status] PRIMARY KEY CLUSTERED 
(
	[status_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[etl_log] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[etl_log](
	[etl_log_id] [int] IDENTITY(1,1) NOT NULL,
	[step_name] [nvarchar](100) NOT NULL,
	[started_at] [datetime2](0) NOT NULL,
	[ended_at] [datetime2](0) NULL,
	[status] [nvarchar](20) NOT NULL,
	[rows_affected] [int] NULL,
	[error_message] [nvarchar](max) NULL,
PRIMARY KEY CLUSTERED 
(
	[etl_log_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Objet : Table [dbo].[fact_call] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[fact_call](
	[call_key] [bigint] IDENTITY(1,1) NOT NULL,
	[call_log_id] [int] NOT NULL,
	[lead_key] [bigint] NULL,
	[date_call_key] [int] NOT NULL,
	[channel_key] [bigint] NOT NULL,
	[agent_key] [bigint] NOT NULL,
	[ring_group] [nvarchar](50) NOT NULL,
	[direction] [nvarchar](10) NOT NULL,
	[call_status] [nvarchar](20) NOT NULL,
	[duration_seconds] [int] NOT NULL,
	[is_answered_flag] [bit] NOT NULL,
	[call_count] [tinyint] NOT NULL,
	[etl_loaded_at] [datetime2](0) NOT NULL,
 CONSTRAINT [PK_fact_call] PRIMARY KEY CLUSTERED 
(
	[call_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_fact_call_call_log_id] UNIQUE NONCLUSTERED 
(
	[call_log_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[fact_lead] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[fact_lead](
	[lead_key] [bigint] IDENTITY(1,1) NOT NULL,
	[conversation_id] [int] NOT NULL,
	[conversation_external_id] [nvarchar](255) NOT NULL,
	[date_created_key] [int] NOT NULL,
	[date_classified_key] [int] NULL,
	[date_appointment_key] [int] NULL,
	[date_last_activity_key] [int] NOT NULL,
	[channel_key] [bigint] NOT NULL,
	[campaign_key] [bigint] NOT NULL,
	[contact_key] [bigint] NOT NULL,
	[assigned_agent_key] [bigint] NOT NULL,
	[classified_by_agent_key] [bigint] NOT NULL,
	[status_key] [int] NOT NULL,
	[classification_key] [int] NOT NULL,
	[qualification_key] [int] NOT NULL,
	[motif_key] [int] NOT NULL,
	[message_count] [int] NOT NULL,
	[unread_count] [int] NOT NULL,
	[lead_count] [tinyint] NOT NULL,
	[is_unanswered_flag] [bit] NOT NULL,
	[is_answered_flag] [bit] NOT NULL,
	[is_classified_flag] [bit] NOT NULL,
	[is_appointment_flag] [bit] NOT NULL,
	[is_won_flag] [bit] NOT NULL,
	[deleted_flag] [bit] NOT NULL,
	[etl_loaded_at] [datetime2](0) NOT NULL,
 CONSTRAINT [PK_fact_lead] PRIMARY KEY CLUSTERED 
(
	[lead_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_fact_lead_conversation] UNIQUE NONCLUSTERED 
(
	[conversation_id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Table [dbo].[fact_qualification_duration] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[fact_qualification_duration](
	[duration_key] [bigint] IDENTITY(1,1) NOT NULL,
	[lead_key] [bigint] NOT NULL,
	[conversation_id] [int] NOT NULL,
	[qualification_key] [int] NOT NULL,
	[agent_key] [bigint] NOT NULL,
	[sequence_number] [smallint] NOT NULL,
	[entered_at] [datetime2](0) NOT NULL,
	[exited_at] [datetime2](0) NULL,
	[duration_hours] [decimal](10, 2) NULL,
	[is_ongoing_flag] [bit] NOT NULL,
 CONSTRAINT [PK_fact_qualification_duration] PRIMARY KEY CLUSTERED 
(
	[duration_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_fqd_conversation_sequence] UNIQUE NONCLUSTERED 
(
	[conversation_id] ASC,
	[sequence_number] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_call_agent] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_call_agent] ON [dbo].[fact_call]
(
	[agent_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_call_channel] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_call_channel] ON [dbo].[fact_call]
(
	[channel_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_call_date] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_call_date] ON [dbo].[fact_call]
(
	[date_call_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_call_lead] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_call_lead] ON [dbo].[fact_call]
(
	[lead_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
SET ANSI_PADDING ON
GO
/****** Objet : Index [IX_fact_call_ring_group] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_call_ring_group] ON [dbo].[fact_call]
(
	[ring_group] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_assigned_agent] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_assigned_agent] ON [dbo].[fact_lead]
(
	[assigned_agent_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_campaign] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_campaign] ON [dbo].[fact_lead]
(
	[campaign_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_channel] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_channel] ON [dbo].[fact_lead]
(
	[channel_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_classification] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_classification] ON [dbo].[fact_lead]
(
	[classification_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_classified_agent] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_classified_agent] ON [dbo].[fact_lead]
(
	[classified_by_agent_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_contact] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_contact] ON [dbo].[fact_lead]
(
	[contact_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_date_appointment] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_date_appointment] ON [dbo].[fact_lead]
(
	[date_appointment_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_date_classified] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_date_classified] ON [dbo].[fact_lead]
(
	[date_classified_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_date_created] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_date_created] ON [dbo].[fact_lead]
(
	[date_created_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_date_last_activity] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_date_last_activity] ON [dbo].[fact_lead]
(
	[date_last_activity_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_motif] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_motif] ON [dbo].[fact_lead]
(
	[motif_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_qualification] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_qualification] ON [dbo].[fact_lead]
(
	[qualification_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fact_lead_status] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fact_lead_status] ON [dbo].[fact_lead]
(
	[status_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fqd_agent] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fqd_agent] ON [dbo].[fact_qualification_duration]
(
	[agent_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fqd_lead] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fqd_lead] ON [dbo].[fact_qualification_duration]
(
	[lead_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Objet : Index [IX_fqd_qualification] Date de script : 05/10/2026 10:31:42 AM ******/
CREATE NONCLUSTERED INDEX [IX_fqd_qualification] ON [dbo].[fact_qualification_duration]
(
	[qualification_key] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, SORT_IN_TEMPDB = OFF, DROP_EXISTING = OFF, ONLINE = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
ALTER TABLE [dbo].[fact_call] ADD  CONSTRAINT [DF_fact_call_agent]  DEFAULT ((-1)) FOR [agent_key]
GO
ALTER TABLE [dbo].[fact_call] ADD  CONSTRAINT [DF_fact_call_ring_group]  DEFAULT (N'Sans groupe') FOR [ring_group]
GO
ALTER TABLE [dbo].[fact_call] ADD  CONSTRAINT [DF_fact_call_duration]  DEFAULT ((0)) FOR [duration_seconds]
GO
ALTER TABLE [dbo].[fact_call] ADD  CONSTRAINT [DF_fact_call_answered]  DEFAULT ((0)) FOR [is_answered_flag]
GO
ALTER TABLE [dbo].[fact_call] ADD  CONSTRAINT [DF_fact_call_count]  DEFAULT ((1)) FOR [call_count]
GO
ALTER TABLE [dbo].[fact_call] ADD  CONSTRAINT [DF_fact_call_etl]  DEFAULT (sysutcdatetime()) FOR [etl_loaded_at]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_campaign]  DEFAULT ((-1)) FOR [campaign_key]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_contact]  DEFAULT ((-1)) FOR [contact_key]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_assigned_agent]  DEFAULT ((-1)) FOR [assigned_agent_key]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_classified_agent]  DEFAULT ((-1)) FOR [classified_by_agent_key]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_qualification]  DEFAULT ((-1)) FOR [qualification_key]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_motif]  DEFAULT ((-1)) FOR [motif_key]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_msg_count]  DEFAULT ((0)) FOR [message_count]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_unread]  DEFAULT ((0)) FOR [unread_count]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_count]  DEFAULT ((1)) FOR [lead_count]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_unanswered]  DEFAULT ((0)) FOR [is_unanswered_flag]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_answered]  DEFAULT ((0)) FOR [is_answered_flag]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_classified]  DEFAULT ((0)) FOR [is_classified_flag]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_appointment]  DEFAULT ((0)) FOR [is_appointment_flag]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_won]  DEFAULT ((0)) FOR [is_won_flag]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_deleted]  DEFAULT ((0)) FOR [deleted_flag]
GO
ALTER TABLE [dbo].[fact_lead] ADD  CONSTRAINT [DF_fact_lead_etl]  DEFAULT (sysutcdatetime()) FOR [etl_loaded_at]
GO
ALTER TABLE [dbo].[fact_qualification_duration] ADD  CONSTRAINT [DF_fqd_agent]  DEFAULT ((-1)) FOR [agent_key]
GO
ALTER TABLE [dbo].[fact_call]  WITH CHECK ADD  CONSTRAINT [FK_fact_call_agent] FOREIGN KEY([agent_key])
REFERENCES [dbo].[dim_agent] ([agent_key])
GO
ALTER TABLE [dbo].[fact_call] CHECK CONSTRAINT [FK_fact_call_agent]
GO
ALTER TABLE [dbo].[fact_call]  WITH CHECK ADD  CONSTRAINT [FK_fact_call_channel] FOREIGN KEY([channel_key])
REFERENCES [dbo].[dim_channel] ([channel_key])
GO
ALTER TABLE [dbo].[fact_call] CHECK CONSTRAINT [FK_fact_call_channel]
GO
ALTER TABLE [dbo].[fact_call]  WITH CHECK ADD  CONSTRAINT [FK_fact_call_date] FOREIGN KEY([date_call_key])
REFERENCES [dbo].[dim_date] ([date_key])
GO
ALTER TABLE [dbo].[fact_call] CHECK CONSTRAINT [FK_fact_call_date]
GO
ALTER TABLE [dbo].[fact_call]  WITH CHECK ADD  CONSTRAINT [FK_fact_call_lead] FOREIGN KEY([lead_key])
REFERENCES [dbo].[fact_lead] ([lead_key])
GO
ALTER TABLE [dbo].[fact_call] CHECK CONSTRAINT [FK_fact_call_lead]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_assigned_agent] FOREIGN KEY([assigned_agent_key])
REFERENCES [dbo].[dim_agent] ([agent_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_assigned_agent]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_campaign] FOREIGN KEY([campaign_key])
REFERENCES [dbo].[dim_campaign] ([campaign_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_campaign]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_channel] FOREIGN KEY([channel_key])
REFERENCES [dbo].[dim_channel] ([channel_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_channel]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_classification] FOREIGN KEY([classification_key])
REFERENCES [dbo].[dim_classification] ([classification_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_classification]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_classified_agent] FOREIGN KEY([classified_by_agent_key])
REFERENCES [dbo].[dim_agent] ([agent_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_classified_agent]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_contact] FOREIGN KEY([contact_key])
REFERENCES [dbo].[dim_contact] ([contact_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_contact]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_date_appointment] FOREIGN KEY([date_appointment_key])
REFERENCES [dbo].[dim_date] ([date_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_date_appointment]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_date_classified] FOREIGN KEY([date_classified_key])
REFERENCES [dbo].[dim_date] ([date_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_date_classified]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_date_created] FOREIGN KEY([date_created_key])
REFERENCES [dbo].[dim_date] ([date_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_date_created]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_date_last_activity] FOREIGN KEY([date_last_activity_key])
REFERENCES [dbo].[dim_date] ([date_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_date_last_activity]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_motif] FOREIGN KEY([motif_key])
REFERENCES [dbo].[dim_motif_contact] ([motif_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_motif]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_qualification] FOREIGN KEY([qualification_key])
REFERENCES [dbo].[dim_qualification] ([qualification_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_qualification]
GO
ALTER TABLE [dbo].[fact_lead]  WITH CHECK ADD  CONSTRAINT [FK_fact_lead_status] FOREIGN KEY([status_key])
REFERENCES [dbo].[dim_status] ([status_key])
GO
ALTER TABLE [dbo].[fact_lead] CHECK CONSTRAINT [FK_fact_lead_status]
GO
ALTER TABLE [dbo].[fact_qualification_duration]  WITH CHECK ADD  CONSTRAINT [FK_fqd_agent] FOREIGN KEY([agent_key])
REFERENCES [dbo].[dim_agent] ([agent_key])
GO
ALTER TABLE [dbo].[fact_qualification_duration] CHECK CONSTRAINT [FK_fqd_agent]
GO
ALTER TABLE [dbo].[fact_qualification_duration]  WITH CHECK ADD  CONSTRAINT [FK_fqd_lead] FOREIGN KEY([lead_key])
REFERENCES [dbo].[fact_lead] ([lead_key])
GO
ALTER TABLE [dbo].[fact_qualification_duration] CHECK CONSTRAINT [FK_fqd_lead]
GO
ALTER TABLE [dbo].[fact_qualification_duration]  WITH CHECK ADD  CONSTRAINT [FK_fqd_qualification] FOREIGN KEY([qualification_key])
REFERENCES [dbo].[dim_qualification] ([qualification_key])
GO
ALTER TABLE [dbo].[fact_qualification_duration] CHECK CONSTRAINT [FK_fqd_qualification]
GO
ALTER TABLE [dbo].[fact_call]  WITH CHECK ADD  CONSTRAINT [CK_fact_call_direction] CHECK  (([direction]=N'internal' OR [direction]=N'outbound' OR [direction]=N'inbound'))
GO
ALTER TABLE [dbo].[fact_call] CHECK CONSTRAINT [CK_fact_call_direction]
GO
/****** Objet : StoredProcedure [dbo].[usp_load_dim_agent] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/* ============================================================================
   3. DIM_AGENT — SCD Type 2 (suivi de nom / rôle / is_active)
   ========================================================================== */
CREATE   PROCEDURE [dbo].[usp_load_dim_agent]
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
 
    UPDATE da
    SET da.expiry_date = @now, da.is_current = 0
    FROM dbo.dim_agent da
    INNER JOIN dbo.src_users su ON su.user_id = da.user_id
    WHERE da.is_current = 1
      AND (da.full_name <> (su.first_name + N' ' + su.last_name)
           OR da.role <> su.role
           OR da.is_active <> su.is_active);
 
    INSERT INTO dbo.dim_agent (user_id, full_name, role, is_active, effective_date, is_current)
    SELECT su.user_id, su.first_name + N' ' + su.last_name, su.role, su.is_active, @now, 1
    FROM dbo.src_users su
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.dim_agent da WHERE da.user_id = su.user_id AND da.is_current = 1
    );
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_dim_campaign] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- =================================================================================
-- PART 5 - Fix usp_load_dim_campaign : src_campaigns n'a pas de "date_diffusion"
--          combinée, seulement diffusion_date + diffusion_time
-- =================================================================================
CREATE   PROCEDURE [dbo].[usp_load_dim_campaign]
AS
BEGIN
    SET NOCOUNT ON;

    MERGE dbo.dim_campaign AS tgt
    USING (
        SELECT campaign_id, platform, title, content_preview, permalink, status,
               date_diffusion = UnifiedBox1.dbo.fn_DateTimeCombine(diffusion_date, diffusion_time)
        FROM dbo.src_campaigns
    ) AS src
    ON tgt.campaign_id = src.campaign_id
    WHEN MATCHED AND (tgt.status <> src.status OR ISNULL(tgt.title,N'') <> ISNULL(src.title,N'')) THEN
        UPDATE SET tgt.status = src.status, tgt.title = src.title, tgt.content_preview = src.content_preview
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (campaign_id, platform, title, content_preview, permalink, date_diffusion, status)
        VALUES (src.campaign_id, src.platform, src.title, src.content_preview, src.permalink, src.date_diffusion, src.status);
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_dim_channel] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/* ============================================================================
   1. DIM_CHANNEL — SCD Type 2 (suivi de is_active / is_verified / auto_reply / nom)
   ========================================================================== */
CREATE   PROCEDURE [dbo].[usp_load_dim_channel]
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
 
    -- 1a. Clôturer les versions dont un attribut suivi a changé
    UPDATE dc
    SET dc.expiry_date = @now, dc.is_current = 0
    FROM dbo.dim_channel dc
    INNER JOIN dbo.src_channels sc ON sc.channel_id = dc.channel_id
    WHERE dc.is_current = 1
      AND (dc.channel_name <> sc.name
           OR dc.is_active <> sc.is_active
           OR dc.is_verified <> sc.is_verified
           OR dc.auto_reply <> sc.auto_reply);
 
    -- 1b. Insérer une nouvelle version pour les channels nouveaux ou modifiés
    INSERT INTO dbo.dim_channel (channel_id, platform, channel_name, external_id, is_active, is_verified, auto_reply, effective_date, is_current)
    SELECT sc.channel_id, sc.platform, sc.name, sc.external_id, sc.is_active, sc.is_verified, sc.auto_reply, @now, 1
    FROM dbo.src_channels sc
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.dim_channel dc WHERE dc.channel_id = sc.channel_id AND dc.is_current = 1
    );
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_dim_classification] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- =================================================================================
-- PART 4 - Nouveaux loaders pour les dimensions de référence (Type 1, clé = source)
-- =================================================================================
CREATE   PROCEDURE [dbo].[usp_load_dim_classification]
AS
BEGIN
    SET NOCOUNT ON;
    MERGE dbo.dim_classification AS tgt
    USING dbo.src_classifications AS src
        ON tgt.classification_key = src.classification_id
    WHEN MATCHED AND (tgt.classification_label_fr <> src.label OR tgt.sort_order <> src.sort_order) THEN
        UPDATE SET tgt.classification_label_fr = src.label, tgt.sort_order = src.sort_order
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (classification_key, classification_label_fr, sort_order)
        VALUES (src.classification_id, src.label, src.sort_order);
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_dim_contact] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
/* ============================================================================
   2. DIM_CONTACT — SCD Type 2 (suivi de is_vip / is_blocked / is_spam / coordonnées)
   ========================================================================== */
CREATE   PROCEDURE [dbo].[usp_load_dim_contact]
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @now DATETIME2(0) = SYSUTCDATETIME();
 
    UPDATE dc
    SET dc.expiry_date = @now, dc.is_current = 0
    FROM dbo.dim_contact dc
    INNER JOIN dbo.src_contacts sc ON sc.contact_id = dc.contact_id
    WHERE dc.is_current = 1
      AND (dc.display_name <> sc.display_name
           OR ISNULL(dc.email, N'') <> ISNULL(sc.email, N'')
           OR ISNULL(dc.phone, N'') <> ISNULL(sc.phone, N'')
           OR ISNULL(dc.company_name, N'') <> ISNULL(sc.company_name, N'')
           OR ISNULL(dc.job_title, N'') <> ISNULL(sc.job_title, N'')
           OR dc.is_vip <> sc.is_vip
           OR dc.is_blocked <> sc.is_blocked
           OR dc.is_spam <> sc.is_spam);
 
    INSERT INTO dbo.dim_contact (contact_id, display_name, email, phone, company_name, job_title, is_vip, is_blocked, is_spam, effective_date, is_current)
    SELECT sc.contact_id, sc.display_name, sc.email, sc.phone, sc.company_name, sc.job_title, sc.is_vip, sc.is_blocked, sc.is_spam, @now, 1
    FROM dbo.src_contacts sc
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.dim_contact dc WHERE dc.contact_id = sc.contact_id AND dc.is_current = 1
    );
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_dim_motif_contact] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE   PROCEDURE [dbo].[usp_load_dim_motif_contact]
AS
BEGIN
    SET NOCOUNT ON;
    MERGE dbo.dim_motif_contact AS tgt
    USING dbo.src_motifs_contact AS src
        ON tgt.motif_key = src.motif_id
    WHEN MATCHED AND tgt.motif_label_fr <> src.label THEN
        UPDATE SET tgt.motif_label_fr = src.label
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (motif_key, motif_label_fr)
        VALUES (src.motif_id, src.label);
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_dim_qualification] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

CREATE   PROCEDURE [dbo].[usp_load_dim_qualification]
AS
BEGIN
    SET NOCOUNT ON;
    MERGE dbo.dim_qualification AS tgt
    USING dbo.src_qualifications AS src
        ON tgt.qualification_key = src.qualification_id
    WHEN MATCHED AND (tgt.qualification_label <> src.label
                    OR tgt.qualification_group <> src.qualification_group
                    OR tgt.is_terminal <> src.is_terminal) THEN
        UPDATE SET tgt.qualification_label = src.label,
                   tgt.qualification_group = src.qualification_group,
                   tgt.is_terminal = src.is_terminal
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (qualification_key, qualification_label, qualification_group, is_terminal)
        VALUES (src.qualification_id, src.label, src.qualification_group, src.is_terminal);
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_fact_call] Date de script : 05/10/2026 10:31:42 AM ******/
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
/****** Objet : StoredProcedure [dbo].[usp_load_fact_lead] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

/* ---- FIX 3 + 4 + 7 : fact_lead ---- */
CREATE   PROCEDURE [dbo].[usp_load_fact_lead]
AS
BEGIN
    SET NOCOUNT ON;

    ;WITH last_msg AS (
        SELECT conversation_id,
               max_sent_at = MAX(UnifiedBox1.dbo.fn_DateTimeCombine(sent_date, sent_time)),
               msg_count   = COUNT(*)
        FROM dbo.src_message
        GROUP BY conversation_id
    ),
    agent_replied AS (
        SELECT DISTINCT conversation_id FROM dbo.src_message WHERE sender_type = N'agent'
    ),
    call_answered AS (          -- FIX 3: a call lead is answered when one of its calls was ANSWERED
        SELECT DISTINCT conversation_id FROM dbo.src_call_log
        WHERE conversation_id IS NOT NULL AND is_answered_flag = 1
    ),
    staged AS (
        SELECT
            c.conversation_id,
            c.external_id                                                      AS conversation_external_id,
            CAST(FORMAT(c.created_date, 'yyyyMMdd') AS INT)                     AS date_created_key,
            CASE WHEN c.classified_date IS NULL THEN NULL
                 ELSE CAST(FORMAT(c.classified_date, 'yyyyMMdd') AS INT) END    AS date_classified_key,
            CASE WHEN c.appointment_date IS NULL OR c.appointment_date = '1900-01-01' THEN NULL
                 ELSE CAST(FORMAT(c.appointment_date, 'yyyyMMdd') AS INT) END   AS date_appointment_key,
            CAST(FORMAT(
                CASE WHEN lm.max_sent_at IS NULL
                          THEN UnifiedBox1.dbo.fn_DateTimeCombine(c.updated_date, c.updated_time)
                     WHEN lm.max_sent_at > UnifiedBox1.dbo.fn_DateTimeCombine(c.updated_date, c.updated_time)
                          THEN lm.max_sent_at
                     ELSE UnifiedBox1.dbo.fn_DateTimeCombine(c.updated_date, c.updated_time) END,
                'yyyyMMdd') AS INT)                                             AS date_last_activity_key,
            ISNULL(dch.channel_key, -1)                                        AS channel_key,
            ISNULL(dca.campaign_key, -1)                                       AS campaign_key,
            ISNULL(dco.contact_key, -1)                                        AS contact_key,
            ISNULL(dag1.agent_key, -1)                                         AS assigned_agent_key,
            ISNULL(dag2.agent_key, -1)                                         AS classified_by_agent_key,
            ISNULL(ds.status_key, -1)                                          AS status_key,
            ISNULL(dcl.classification_key, -1)                                 AS classification_key,
            ISNULL(dq.qualification_key, -1)                                   AS qualification_key,
            ISNULL(dm.motif_key, -1)                                           AS motif_key,
            -- FIX 4: imported leads have no message rows -> keep the count coming from the import
            CASE WHEN ISNULL(lm.msg_count, 0) >= c.message_count THEN ISNULL(lm.msg_count, 0)
                 ELSE c.message_count END                                      AS message_count,
            c.unread_count                                                     AS unread_count,
            1 - f2.is_ans                                                      AS is_unanswered_flag,
            f2.is_ans                                                          AS is_answered_flag,
            f1.is_class                                                        AS is_classified_flag,
            CASE WHEN c.appointment_date IS NOT NULL AND c.appointment_date <> '1900-01-01' THEN 1 ELSE 0 END AS is_appointment_flag,
            CASE WHEN dq.qualification_group = N'Gagné' THEN 1 ELSE 0 END      AS is_won_flag,
            CASE WHEN c.deleted_date IS NOT NULL THEN 1 ELSE 0 END             AS deleted_flag
        FROM dbo.src_conversations c
        LEFT JOIN last_msg lm        ON lm.conversation_id = c.conversation_id
        LEFT JOIN agent_replied ar   ON ar.conversation_id = c.conversation_id
        LEFT JOIN call_answered ca   ON ca.conversation_id = c.conversation_id
        LEFT JOIN dbo.dim_channel dch ON dch.channel_id = c.channel_id AND dch.is_current = 1
        LEFT JOIN dbo.dim_campaign dca ON dca.campaign_id = c.campaign_id
        LEFT JOIN dbo.dim_contact dco ON dco.contact_id = c.contact_id AND dco.is_current = 1
        LEFT JOIN dbo.dim_agent dag1 ON dag1.user_id = c.assigned_to_user_id AND dag1.is_current = 1
        LEFT JOIN dbo.dim_agent dag2 ON dag2.user_id = c.classified_by_user_id AND dag2.is_current = 1
        LEFT JOIN dbo.dim_status ds ON ds.status_code = c.status
        LEFT JOIN dbo.dim_classification dcl ON dcl.classification_key = c.classification_id
        LEFT JOIN dbo.dim_qualification dq ON dq.qualification_key = c.qualification_id
        LEFT JOIN dbo.dim_motif_contact dm ON dm.motif_key = c.motif_id
        -- FIX 7: classified = classification label is not 'Non classifié' (no more "id <> 1")
        CROSS APPLY (SELECT is_class = CASE WHEN dcl.classification_key IS NOT NULL
                                             AND dcl.classification_key <> -1
                                             AND dcl.classification_label_fr <> N'Non classifié'
                                            THEN 1 ELSE 0 END) f1
        -- FIX 3/4: answered = agent message OR answered call OR (imported, no messages, already classified)
        CROSS APPLY (SELECT is_ans = CASE WHEN ar.conversation_id IS NOT NULL
                                            OR ca.conversation_id IS NOT NULL
                                            OR (c.external_id LIKE N'IMPORT-%'
                                                AND lm.conversation_id IS NULL
                                                AND f1.is_class = 1)
                                          THEN 1 ELSE 0 END) f2
    )
    MERGE dbo.fact_lead AS tgt
    USING staged AS src
    ON tgt.conversation_id = src.conversation_id
    WHEN MATCHED THEN
        UPDATE SET
            date_classified_key = src.date_classified_key,
            date_appointment_key = src.date_appointment_key,
            date_last_activity_key = src.date_last_activity_key,
            channel_key = src.channel_key,
            campaign_key = src.campaign_key,
            contact_key = src.contact_key,
            assigned_agent_key = src.assigned_agent_key,
            classified_by_agent_key = src.classified_by_agent_key,
            status_key = src.status_key,
            classification_key = src.classification_key,
            qualification_key = src.qualification_key,
            motif_key = src.motif_key,
            message_count = src.message_count,
            unread_count = src.unread_count,
            is_unanswered_flag = src.is_unanswered_flag,
            is_answered_flag = src.is_answered_flag,
            is_classified_flag = src.is_classified_flag,
            is_appointment_flag = src.is_appointment_flag,
            is_won_flag = src.is_won_flag,
            deleted_flag = src.deleted_flag,
            etl_loaded_at = SYSUTCDATETIME()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (conversation_id, conversation_external_id, date_created_key, date_classified_key, date_appointment_key,
                date_last_activity_key, channel_key, campaign_key, contact_key, assigned_agent_key, classified_by_agent_key,
                status_key, classification_key, qualification_key, motif_key, message_count, unread_count,
                is_unanswered_flag, is_answered_flag, is_classified_flag, is_appointment_flag, is_won_flag, deleted_flag)
        VALUES (src.conversation_id, src.conversation_external_id, src.date_created_key, src.date_classified_key, src.date_appointment_key,
                src.date_last_activity_key, src.channel_key, src.campaign_key, src.contact_key, src.assigned_agent_key, src.classified_by_agent_key,
                src.status_key, src.classification_key, src.qualification_key, src.motif_key, src.message_count, src.unread_count,
                src.is_unanswered_flag, src.is_answered_flag, src.is_classified_flag, src.is_appointment_flag, src.is_won_flag, src.deleted_flag);
END
GO
/****** Objet : StoredProcedure [dbo].[usp_load_fact_qualification_duration] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- =================================================================================
-- PART 8 - Fix usp_load_fact_qualification_duration : h.changed_at n'existe pas
--          (changed_date + changed_time)
-- =================================================================================
CREATE   PROCEDURE [dbo].[usp_load_fact_qualification_duration]
AS
BEGIN
    SET NOCOUNT ON;

    ;WITH base AS (
        SELECT
            h.conversation_id,
            h.qualification_id,
            h.changed_by_user_id,
            changed_at = UnifiedBox1.dbo.fn_DateTimeCombine(h.changed_date, h.changed_time)
        FROM dbo.src_conversation_qualification_history h
    ),
    ordered AS (
        SELECT
            conversation_id, qualification_id, changed_by_user_id, changed_at,
            sequence_number = ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY changed_at),
            next_changed_at = LEAD(changed_at) OVER (PARTITION BY conversation_id ORDER BY changed_at)
        FROM base
    ),
    staged AS (
        SELECT
            fl.lead_key,
            o.conversation_id,
            o.qualification_id,
            ISNULL(da.agent_key, -1) AS agent_key,
            o.sequence_number,
            o.changed_at AS entered_at,
            o.next_changed_at AS exited_at,
            CASE WHEN o.next_changed_at IS NULL THEN NULL
                 ELSE CAST(DATEDIFF(MINUTE, o.changed_at, o.next_changed_at) / 60.0 AS DECIMAL(10,2)) END AS duration_hours,
            CASE WHEN o.next_changed_at IS NULL THEN 1 ELSE 0 END AS is_ongoing_flag
        FROM ordered o
        INNER JOIN dbo.fact_lead fl ON fl.conversation_id = o.conversation_id
        LEFT JOIN dbo.dim_agent da ON da.user_id = o.changed_by_user_id AND da.is_current = 1
    )
    MERGE dbo.fact_qualification_duration AS tgt
    USING staged AS src
    ON tgt.conversation_id = src.conversation_id AND tgt.sequence_number = src.sequence_number
    WHEN MATCHED THEN
        UPDATE SET
            qualification_key = src.qualification_id,
            agent_key = src.agent_key,
            exited_at = src.exited_at,
            duration_hours = src.duration_hours,
            is_ongoing_flag = src.is_ongoing_flag
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (lead_key, conversation_id, qualification_key, agent_key, sequence_number, entered_at, exited_at, duration_hours, is_ongoing_flag)
        VALUES (src.lead_key, src.conversation_id, src.qualification_id, src.agent_key, src.sequence_number, src.entered_at, src.exited_at, src.duration_hours, src.is_ongoing_flag);
END
GO
/****** Objet : StoredProcedure [dbo].[usp_run_etl] Date de script : 05/10/2026 10:31:42 AM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- =================================================================================
-- PART 9 - Orchestrateur mis à jour : ajoute les 3 nouveaux loaders de dimensions
--          de référence avant fact_lead (dont ils sont des dépendances)
-- =================================================================================
CREATE   PROCEDURE [dbo].[usp_run_etl]
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @step NVARCHAR(100);
    DECLARE @log_id INT;

    BEGIN TRY
        DECLARE step_cursor CURSOR LOCAL FAST_FORWARD FOR
            SELECT step_name FROM (VALUES
                (N'usp_load_dim_channel'), (N'usp_load_dim_contact'), (N'usp_load_dim_agent'),
                (N'usp_load_dim_campaign'), (N'usp_load_dim_classification'),
                (N'usp_load_dim_qualification'), (N'usp_load_dim_motif_contact'),
                (N'usp_load_fact_lead'),
                (N'usp_load_fact_qualification_duration'), (N'usp_load_fact_call')
            ) AS steps(step_name);

        OPEN step_cursor;
        FETCH NEXT FROM step_cursor INTO @step;

        WHILE @@FETCH_STATUS = 0
        BEGIN
            INSERT INTO dbo.etl_log (step_name, started_at, status) VALUES (@step, SYSUTCDATETIME(), N'RUNNING');
            SET @log_id = SCOPE_IDENTITY();

            EXEC (N'EXEC dbo.' + @step);

            UPDATE dbo.etl_log SET ended_at = SYSUTCDATETIME(), status = N'SUCCESS' WHERE etl_log_id = @log_id;
            FETCH NEXT FROM step_cursor INTO @step;
        END

        CLOSE step_cursor;
        DEALLOCATE step_cursor;
    END TRY
    BEGIN CATCH
        IF CURSOR_STATUS('local', 'step_cursor') >= -1
        BEGIN
            CLOSE step_cursor;
            DEALLOCATE step_cursor;
        END
        UPDATE dbo.etl_log
        SET ended_at = SYSUTCDATETIME(), status = N'FAILED', error_message = ERROR_MESSAGE()
        WHERE etl_log_id = @log_id;
        THROW;
    END CATCH
END
GO
USE [master]
GO
ALTER DATABASE [UnifiedBoxDW] SET  READ_WRITE 
GO
