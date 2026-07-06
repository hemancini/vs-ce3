
export interface ArsmateCreatorStats {
    posts: number;
    photos: number | string;
    videos: number | string;
    likes: number;
    subscribers: number | null;
}

export interface ArsmateCreatorLinks {
    instagram: string;
    twitter: string;
    facebook: string;
    tiktok: string;
    youtube: string;
    web: string;
    discord: string;
}

export interface ArsmateCreator {
    id: number;
    name: string;
    username: string;
    avatar: string;
    cover: string;
    about: string;
    isVerified: boolean;
    isFeatured: boolean;
    isFree: boolean;
    price: string;
    links?: ArsmateCreatorLinks;
    stats: ArsmateCreatorStats;
    createdAt?: string;
    isMonetizationBlocked?: boolean;
}

export interface ArsmateCreatorResponse {
    success: boolean;
    creator: ArsmateCreator;
}

export interface ArsmateSearchResponse {
    success: boolean;
    creators: ArsmateCreator[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
}

export interface ArsmateMedia {
    type: 'image' | 'video' | string;
    id: number;
    url?: string;
    videoUrl?: string;
    hlsManifestUrl?: string | null;
    thumbnail?: string | null;
    previewGif?: string | null;
    width?: number;
    height?: number;
    proxiedUrl?: string;
    videoSource?: string;
}

export interface ArsmatePostAuthor {
    id: number;
    name: string;
    username: string;
    avatar: string;
    verified: boolean;
    subscription_price: number;
    isMonetizationBlocked: boolean;
}

export interface ArsmatePost {
    id: number;
    text: string;
    media: ArsmateMedia | ArsmateMedia[] | null;
    rawMedia?: ArsmateMedia[];
    content?: {
        type: string;
        text?: string;
        images?: ArsmateMedia[];
    };
    postType: 'image' | 'video' | 'mixed' | 'text' | 'photos' | string;
    contentType?: string;
    locked?: string;
    isLocked?: boolean | number | null;
    hasAccess: boolean;
    price: number | null;
    likesCount: number;
    commentsCount: number;
    createdAt: string;
    publishedAt: string;
    author: ArsmatePostAuthor;
    user?: any;
    // Enriched fields
    creatorAvatar?: string | null;
    creatorName?: string;
    formattedDate?: string | null;
    hlsManifestUrl?: string | null;
    mediaItems?: any[];
}

export interface ArsmateFeedResponse {
    success: boolean;
    posts: ArsmatePost[];
    total?: number;
    page?: number;
    limit?: number;
    hasMore?: boolean;
}

export interface ArsmateSubscriptionCreator {
    id: number;
    name: string;
    username: string;
    avatar: string;
    verified: boolean;
}

export interface ArsmateSubscription {
    id: number;
    status: string;
    startDate: string;
    endDate: string;
    interval: string;
    creator: ArsmateSubscriptionCreator;
}

export interface ArsmateSubscriptionsResponse {
    success: boolean;
    subscriptions: ArsmateSubscription[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
}
