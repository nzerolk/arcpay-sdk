import type { AppProvider } from '@/lib/app/AppProvider'
import type { WalletAccount } from "@txnlab/use-wallet";
import router from '@/router'
import {type Database} from "@/lib/supabase/database.types";

export interface BuyParams {
  type: 'sale',
  nftID: string,
  appIndex: number,
  sellerAddress: string
  price: number,
  feesAppAddress: string,
  feesAppId: string,
  currency: Database['public']['Tables']['currencies']['Row'] | undefined
}

// export function createListing(appProvider: AppProvider, account: WalletAccount, options?: CreateListingOptions) {
//   return new Promise<ListingCreationParams>((resolve, reject) => {
//     appProvider.provide('ListingCreation', {account, options}, (params: ListingCreationParams, error?: Error) => {
//       if (error) reject(error)
//       resolve(params)
//     })
//     router.push({name: 'listing-creation'})
//   })
// }
